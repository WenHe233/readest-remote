// Opt-in acceptance phase: Kavita's web reader has just saved page 4 of the
// fixture EPUB. This test restores it in the native reader, then writes page 5.
import { describe, expect, it, vi } from 'vitest';
import { installPlugin, uninstallPlugin, getLibraryRuntime } from '@/services/plugins/manager';
import { verifyPluginPackage } from '@/services/plugins/package';
import { savePluginConnection } from '@/services/plugins/connections';
import { reconcileExternalCatalog } from '@/services/plugins/library';
import { openExternalBook } from '@/services/plugins/content';
import {
  capturePluginPosition,
  resolvePluginPosition,
  pushPluginPosition,
} from '@/services/plugins/progress';
import type { PluginConnection } from '@/services/plugins/types';
import type { RemoteBook } from '@readest/plugin-sdk';
import type { FoliateView } from '@/types/view';
import type { BookProgress } from '@/types/book';
import type { ClosableFile } from '@/utils/file';
declare const __PLUGIN_TEST_WEB_PROGRESS__: boolean;
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_SERVERS__: Record<string, { url: string; apiKey: string }> | null;
declare const __PLUGIN_TEST_BOOKS__: Record<string, Record<string, RemoteBook>>;
describe.runIf(!!__PLUGIN_TEST_SERVERS__ && __PLUGIN_TEST_WEB_PROGRESS__)(
  'Kavita web reader to native reader round trip',
  () => {
    it('restores Komga web PDF page 4 and sends native page 5 back', async () => {
      const pkg = await verifyPluginPackage(
        Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__['komga']!), (c) => c.charCodeAt(0)),
      );
      await uninstallPlugin(pkg.manifest.id);
      await installPlugin(pkg, true);
      const server = __PLUGIN_TEST_SERVERS__!['komga']!;
      const connection: PluginConnection = {
        id: crypto.randomUUID(),
        pluginId: pkg.manifest.id,
        fingerprint: pkg.fingerprint,
        sourceId: 'komga',
        name: 'Web PDF acceptance',
        url: server.url,
        config: {},
        secretNames: ['apiKey'],
        libraryIds: [],
        addedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await savePluginConnection(connection, { apiKey: server.apiKey }, false);
      const target = await getLibraryRuntime(connection.id);
      const [book] = reconcileExternalCatalog(
        connection,
        [__PLUGIN_TEST_BOOKS__['komga']!['PDF']!],
        [],
      );
      const remote = await target.runtime.call('library.pullProgress', {
        context: target.lease.context,
        book: book!.externalSource!.item,
      });
      expect(remote?.pageIndex).toBe(3);
      const { NativeAppService } = await import('@/services/nativeAppService');
      const app = new NativeAppService(process.env['CWD'] + '/.readest-test-sandbox-tauri/web-pdf');
      await app.init();
      const opened = await openExternalBook(app, book!);
      await import('foliate-js/view.js');
      const view = document.createElement('foliate-view') as FoliateView;
      view.style.cssText =
        'display:block;position:fixed;inset:0;width:800px;height:600px;background:white';
      document.body.append(view);
      try {
        await view.open(opened.book);
        await Promise.resolve(view.goTo(0));
        const restored = await resolvePluginPosition(remote!, opened.book, view);
        expect(restored.approximate).toBe(false);
        await Promise.resolve(view.goTo(restored.pageIndex!));
        await vi.waitFor(() => expect(view.resolveCFI(view.lastLocation!.cfi!).index).toBe(3));
        await Promise.resolve(view.goTo(4));
        await pushPluginPosition(book!, {
          kind: 'page',
          pageIndex: 4,
          fraction: 4 / (opened.book.sections.length - 1),
          modified: Date.now(),
        });
      } finally {
        view.close();
        view.remove();
        await opened.book.destroy?.();
      }
    });
    it('restores the observed web chapter and sends the next native chapter back', async () => {
      const pkg = await verifyPluginPackage(
        Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__['kavita']!), (c) => c.charCodeAt(0)),
      );
      await uninstallPlugin(pkg.manifest.id);
      await installPlugin(pkg, true);
      const server = __PLUGIN_TEST_SERVERS__!['kavita']!;
      const connection: PluginConnection = {
        id: crypto.randomUUID(),
        pluginId: pkg.manifest.id,
        fingerprint: pkg.fingerprint,
        sourceId: 'kavita',
        name: 'Web reader acceptance',
        url: server.url,
        config: {},
        secretNames: ['apiKey'],
        libraryIds: [],
        addedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await savePluginConnection(connection, { apiKey: server.apiKey }, false);
      const target = await getLibraryRuntime(connection.id);
      const [book] = reconcileExternalCatalog(
        connection,
        [__PLUGIN_TEST_BOOKS__['kavita']!['EPUB']!],
        [],
      );
      const remote = await target.runtime.call('library.pullProgress', {
        context: target.lease.context,
        book: book!.externalSource!.item,
      });
      expect(remote?.spineIndex).toBe(3);
      const { NativeAppService } = await import('@/services/nativeAppService');
      const app = new NativeAppService(
        process.env['CWD'] + '/.readest-test-sandbox-tauri/web-progress',
      );
      await app.init();
      const opened = await openExternalBook(app, book!);
      await import('foliate-js/view.js');
      const view = document.createElement('foliate-view') as FoliateView;
      view.style.cssText =
        'display:block;position:fixed;inset:0;width:800px;height:600px;background:white';
      document.body.append(view);
      try {
        await view.open(opened.book);
        await Promise.resolve(view.goTo(0));
        const restored = await resolvePluginPosition(remote!, opened.book, view);
        expect(restored.approximate).toBe(false);
        await Promise.resolve(view.goTo(restored.cfi!));
        await vi.waitFor(() => expect(view.resolveCFI(view.lastLocation!.cfi!).index).toBe(3));
        expect((await opened.book.sections[3]!.createDocument()).body.textContent).toContain(
          '阅读之前',
        );
        await Promise.resolve(view.goTo(4));
        const cfi = view.lastLocation!.cfi!;
        const progress = await view.getCFIProgress(cfi);
        await pushPluginPosition(
          book!,
          await capturePluginPosition(
            book!,
            opened.book,
            {
              location: cfi,
              index: view.resolveCFI(cfi).index,
              fraction: progress!.fraction,
              range: view.lastLocation!.range!,
            } as BookProgress,
            view,
          ),
        );
      } finally {
        view.close();
        view.remove();
        await opened.book.destroy?.();
        await (opened.file as ClosableFile | null)?.close?.();
      }
    });
  },
);
