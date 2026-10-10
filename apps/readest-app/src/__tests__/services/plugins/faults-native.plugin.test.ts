import { describe, expect, it, vi } from 'vitest';
import {
  installPlugin,
  uninstallPlugin,
  getLibraryRuntime,
  probeLibraryConnection,
} from '@/services/plugins/manager';
import { verifyPluginPackage } from '@/services/plugins/package';
import { savePluginConnection } from '@/services/plugins/connections';
import { getConnectionSecrets } from '@/services/plugins/vault';
import { reconcileExternalCatalog, syncExternalLibrary } from '@/services/plugins/library';
import { openExternalBook } from '@/services/plugins/content';
import {
  cancelExternalDownload,
  downloadExternalBook,
  removeExternalOfflineBook,
} from '@/services/plugins/offline';
import {
  capturePluginPosition,
  resolvePluginPosition,
  pushPluginPosition,
  getSavedPluginProgress,
  retryQueuedPluginProgress,
} from '@/services/plugins/progress';
import { getLocalBookFilename } from '@/utils/book';
import { useLibraryStore } from '@/store/libraryStore';
import type { RemoteBook } from '@readest/plugin-sdk';
import type { PluginConnection } from '@/services/plugins/types';
import type { BookProgress } from '@/types/book';
import type { FoliateView } from '@/types/view';
import type { ClosableFile } from '@/utils/file';
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_SERVERS__: Record<string, { url: string; apiKey: string }> | null;
declare const __PLUGIN_TEST_BOOKS__: Record<string, Record<string, RemoteBook>>;

describe.runIf(!!__PLUGIN_TEST_SERVERS__)(
  'native external library failure and position recovery',
  () => {
    for (const name of ['kavita', 'komga'])
      it(name +
        ' retains metadata, cleans canceled downloads and restores a server EPUB anchor', async () => {
        const server = __PLUGIN_TEST_SERVERS__![name]!;
        const pkg = await verifyPluginPackage(
          Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__[name]!), (c) => c.charCodeAt(0)),
        );
        await uninstallPlugin(pkg.manifest.id);
        await installPlugin(pkg, true);
        const connection: PluginConnection = {
          id: crypto.randomUUID(),
          pluginId: pkg.manifest.id,
          fingerprint: pkg.fingerprint,
          sourceId: name,
          name: 'Fault fixture ' + name,
          url: server.url,
          config: {},
          secretNames: ['apiKey'],
          libraryIds: [],
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        const example = __PLUGIN_TEST_BOOKS__[name]!['EPUB']!;
        connection.libraryIds = [example.libraryId];
        await savePluginConnection(connection, { apiKey: server.apiKey }, false);
        const target = await getLibraryRuntime(connection.id);
        const { NativeAppService } = await import('@/services/nativeAppService');
        const app = new NativeAppService(
          process.env['CWD'] + '/.readest-test-sandbox-tauri/faults-' + name,
        );
        await app.init();
        const [book] = reconcileExternalCatalog(connection, [example], []);
        useLibraryStore.getState().setLibrary([book!]);
        await expect(
          probeLibraryConnection(connection, { apiKey: 'invalid-fixture-key' }, {}),
        ).rejects.toThrow();
        expect((await getConnectionSecrets(connection.id))['apiKey']).toBe(server.apiKey);
        const call = target.runtime.call.bind(target.runtime);
        let pages = 0;
        const scan = vi.spyOn(target.runtime, 'call').mockImplementation(async (...args) => {
          if (args[0] === 'library.syncCatalog') {
            if (pages++ === 0) return { books: [], complete: false, nextCursor: 'next' } as never;
            throw new Error('Connection lost during directory scan');
          }
          return call(...args);
        });
        await expect(syncExternalLibrary(app, connection.id)).rejects.toThrow(/scan/);
        expect(useLibraryStore.getState().library).toEqual([book!]);
        scan.mockRestore();
        await expect(
          downloadExternalBook(app, book!, () => cancelExternalDownload(book!.hash)),
        ).rejects.toThrow(/cancel/i);
        expect(await app.exists(getLocalBookFilename(book!), 'Books')).toBe(false);
        expect(await app.exists(getLocalBookFilename(book!) + '.part', 'Books')).toBe(false);
        expect(book!.externalDownloadedAt).toBeUndefined();
        const opened = await openExternalBook(app, book!);
        await import('foliate-js/view.js');
        const view = document.createElement('foliate-view') as FoliateView;
        view.style.cssText =
          'display:block;position:fixed;inset:0;width:800px;height:600px;background:white';
        document.body.append(view);
        try {
          await view.open(opened.book);
          await Promise.resolve(view.goTo(3));
          await vi.waitFor(() => expect(view.lastLocation?.cfi).toBeTruthy());
          const cfi = view.lastLocation!.cfi!;
          const index = view.resolveCFI(cfi).index;
          const fraction = (await view.getCFIProgress(cfi))!.fraction;
          const position = await capturePluginPosition(
            book!,
            opened.book,
            { location: cfi, index, fraction, range: view.lastLocation!.range! } as BookProgress,
            view,
          );
          expect(position.href).toBeTruthy();
          await pushPluginPosition(book!, position);
          expect((await getSavedPluginProgress(book!.hash))?.pending).toBe(false);
          const remote = await target.runtime.call('library.pullProgress', {
            context: target.lease.context,
            book: example,
          });
          expect(remote).not.toBeNull();
          const restored = await resolvePluginPosition(remote!, opened.book, view);
          console.info(
            'Native EPUB anchor',
            JSON.stringify({ name, position, remote, restored, index }),
          );
          expect(restored.approximate).toBe(false);
          expect(restored.cfi).toBeTruthy();
          await Promise.resolve(view.goTo(0));
          await Promise.resolve(view.goTo(restored.cfi!));
          await vi.waitFor(() =>
            expect(view.resolveCFI(view.lastLocation!.cfi!).index).toBe(index),
          );
          const offline = vi.spyOn(target.runtime, 'call').mockRejectedValue(new Error('Offline'));
          await expect(
            pushPluginPosition(book!, { ...position, modified: Date.now() }),
          ).rejects.toThrow(/Offline/);
          expect((await getSavedPluginProgress(book!.hash))?.pending).toBe(true);
          offline.mockRestore();
          expect(await retryQueuedPluginProgress([book!], new Set())).toEqual([]);
          expect((await getSavedPluginProgress(book!.hash))?.pending).toBe(false);
        } finally {
          view.close();
          view.remove();
          await opened.book.destroy?.();
          await (opened.file as ClosableFile | null)?.close?.();
        }
        await downloadExternalBook(app, book!);
        expect(book!.externalDownloadedAt).toBeGreaterThan(0);
        await removeExternalOfflineBook(app, book!);
      }, 180000);
  },
);
