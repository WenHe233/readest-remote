import { page } from 'vitest/browser';
import type { BookDoc } from '@/libs/document';
import type { FoliateView } from '@/types/view';
import { describe, expect, it, vi } from 'vitest';
import { installPlugin, uninstallPlugin, getLibraryRuntime } from '@/services/plugins/manager';
import { verifyPluginPackage } from '@/services/plugins/package';
import { savePluginConnection } from '@/services/plugins/connections';
import { reconcileExternalCatalog, fetchExternalCover } from '@/services/plugins/library';
import { openExternalBook } from '@/services/plugins/content';
import { downloadExternalBook, removeExternalOfflineBook } from '@/services/plugins/offline';
import { clearContentCache } from '@/services/plugins/cache';
import { useLibraryStore } from '@/store/libraryStore';
import { getCoverFilename } from '@/utils/book';
import type { RemoteBook } from '@readest/plugin-sdk';
import type { PluginConnection } from '@/services/plugins/types';
import type { ClosableFile } from '@/utils/file';
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_ARTIFACTS__: string;
declare const __PLUGIN_TEST_SERVERS__: Record<string, { url: string; apiKey: string }> | null;
declare const __PLUGIN_TEST_BOOKS__: Record<string, Record<string, RemoteBook>>;
const bytes = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
async function renderSection(doc: BookDoc, index = 0, screenshot?: string): Promise<void> {
  await import('foliate-js/view.js');
  const view = document.createElement('foliate-view') as FoliateView;
  view.style.cssText =
    'display:block;position:fixed;inset:0;width:800px;height:600px;background:white;z-index:9999';
  document.body.append(view);
  try {
    await view.open(doc);
    await Promise.resolve(view.goTo(index));
    await vi.waitFor(() => expect(view.renderer.getContents().length).toBeGreaterThan(0), {
      timeout: 30000,
    });
    for (const content of view.renderer.getContents())
      for (const image of content.doc.querySelectorAll('img')) {
        if (image.getAttribute('src'))
          await vi.waitFor(() => expect(image.naturalWidth).toBeGreaterThan(0), { timeout: 30000 });
      }
    if (screenshot)
      await page.screenshot({ path: __PLUGIN_TEST_ARTIFACTS__ + '/' + screenshot + '.png' });
  } finally {
    view.close();
    view.remove();
  }
}
describe.runIf(!!__PLUGIN_TEST_SERVERS__)(
  'Windows native plugin content with real libraries',
  () => {
    for (const name of ['kavita', 'komga'])
      it(name +
        ' opens, seeks, caches, downloads and opens offline all three formats', async () => {
        const server = __PLUGIN_TEST_SERVERS__![name]!;
        const nativeFetch = (await import('@tauri-apps/plugin-http')).fetch;
        try {
          console.info('Native connection probe', name, (await nativeFetch(server.url)).status);
        } catch (error) {
          throw new Error('Native connection probe: ' + String(error));
        }
        const pkg = await verifyPluginPackage(bytes(__PLUGIN_TEST_PACKAGES__[name]!));
        await uninstallPlugin(pkg.manifest.id);
        await installPlugin(pkg, true);
        const connection: PluginConnection = {
          id: crypto.randomUUID(),
          pluginId: pkg.manifest.id,
          fingerprint: pkg.fingerprint,
          sourceId: name,
          name: 'V2 test ' + name,
          url: server.url,
          config: {},
          secretNames: ['apiKey'],
          libraryIds: [],
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await savePluginConnection(connection, { apiKey: server.apiKey }, false);
        const { NativeAppService } = await import('@/services/nativeAppService');
        const app = new NativeAppService(
          process.env['CWD'] + '/.readest-test-sandbox-tauri/external-' + name,
        );
        await app.init();
        const target = await getLibraryRuntime(connection.id);
        await target.runtime.call('library.testConnection', { context: target.lease.context });
        const books = reconcileExternalCatalog(
          connection,
          Object.values(__PLUGIN_TEST_BOOKS__[name]!),
          [],
        );
        useLibraryStore.getState().setLibrary(books);
        const request = target.lease.request.bind(target.lease);
        let requested = 0;
        let count = 0;
        target.lease.request = async (...args) => {
          const response = await request(...args);
          requested += Number(response.headers.get('content-length')) || 0;
          count++;
          return response;
        };
        for (const book of books) {
          target.lease.request = async (...args) => {
            const response = await request(...args);
            requested += Number(response.headers.get('content-length')) || 0;
            count++;
            return response;
          };
          await removeExternalOfflineBook(app, book);
          await clearContentCache(book.hash);
          requested = 0;
          count = 0;
          const result = await openExternalBook(app, book);
          expect(result.book.sections.length).toBeGreaterThan(0);
          await renderSection(result.book, 0, name + '-' + book.format);
          const firstScreenBytes = requested;
          if (result.book.sections.length > 2) await renderSection(result.book, 2);
          const coldBytes = requested;
          if (book.format === 'PDF' && name === 'kavita')
            expect(firstScreenBytes).toBeLessThan(book.externalSource!.item.size! * 0.9);
          console.info(
            JSON.stringify({
              provider: name,
              format: book.format,
              requests: count,
              firstScreenBytes,
              streamBytes: coldBytes,
              fileBytes: book.externalSource?.item.size,
            }),
          );
          await result.book.destroy?.();
          await (result.file as ClosableFile | null)?.close?.();
          requested = 0;
          const cached = await openExternalBook(app, book);
          await renderSection(cached.book);
          await cached.book.destroy?.();
          await (cached.file as ClosableFile | null)?.close?.();
          expect(requested).toBeLessThanOrEqual(coldBytes);
          await fetchExternalCover(app, book);
          expect(await app.exists(getCoverFilename(book), 'Books')).toBe(true);
          await downloadExternalBook(app, book);
          expect(book.externalDownloadedAt).toBeGreaterThan(0);
          target.lease.request = async () => {
            throw new Error('Simulated offline');
          };
          const offline = await openExternalBook(app, book);
          expect(offline.file).not.toBeNull();
          await renderSection(offline.book, 0, name + '-' + book.format + '-offline');
          if (book.format === 'PDF') expect(typeof offline.book.getPageThumbnail).toBe('function');
          await offline.book.destroy?.();
          await (offline.file as ClosableFile | null)?.close?.();
          target.lease.request = request;
          await removeExternalOfflineBook(app, book);
        }
      }, 300000);
  },
);
