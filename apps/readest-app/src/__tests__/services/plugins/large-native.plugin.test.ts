import { describe, expect, it, vi } from 'vitest';
import { installPlugin, uninstallPlugin, getLibraryRuntime } from '@/services/plugins/manager';
import { verifyPluginPackage } from '@/services/plugins/package';
import { savePluginConnection } from '@/services/plugins/connections';
import { reconcileExternalCatalog } from '@/services/plugins/library';
import { openExternalBook } from '@/services/plugins/content';
import { clearContentCache } from '@/services/plugins/cache';
import type { RemoteBook } from '@readest/plugin-sdk';
import type { PluginConnection } from '@/services/plugins/types';
import type { FoliateView } from '@/types/view';
import type { ClosableFile } from '@/utils/file';
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_BOOKS__: Record<string, Record<string, RemoteBook>>;
declare const __PLUGIN_TEST_SERVERS__: Record<string, { url: string; apiKey: string }> | null;
describe.runIf(!!__PLUGIN_TEST_SERVERS__)('large EPUB range/resource benchmarks', () => {
  for (const name of ['kavita', 'komga'])
    it(name + ' opens a large EPUB without downloading the whole file', async () => {
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
        name: 'Large EPUB ' + name,
        url: server.url,
        config: {},
        secretNames: ['apiKey'],
        libraryIds: [],
        addedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await savePluginConnection(connection, { apiKey: server.apiKey }, false);
      const target = await getLibraryRuntime(connection.id);
      const { NativeAppService } = await import('@/services/nativeAppService');
      const app = new NativeAppService(
        process.env['CWD'] + '/.readest-test-sandbox-tauri/large-' + name,
      );
      await app.init();
      for (const key of ['LARGE_EPUB', 'MULTI_EPUB']) {
        const item = __PLUGIN_TEST_BOOKS__[name]![key];
        if (!item) continue;
        const [book] = reconcileExternalCatalog(connection, [item], []);
        await clearContentCache(book!.hash);
        const request = target.lease.request.bind(target.lease);
        let bytes = 0,
          requests = 0;
        target.lease.request = async (...args) => {
          const result = await request(...args);
          bytes += Number(result.headers.get('content-length')) || 0;
          requests++;
          return result;
        };
        const opened = await openExternalBook(app, book!);
        await import('foliate-js/view.js');
        const view = document.createElement('foliate-view') as FoliateView;
        view.style.cssText =
          'display:block;position:fixed;inset:0;width:800px;height:600px;background:white';
        document.body.append(view);
        try {
          await view.open(opened.book);
          await Promise.resolve(view.goTo(0));
          expect(view.renderer.getContents().length).toBeGreaterThan(0);
          for (const content of view.renderer.getContents())
            for (const image of content.doc.querySelectorAll('img')) {
              if (image.getAttribute('src'))
                await vi.waitFor(() => expect(image.naturalWidth).toBeGreaterThan(0), {
                  timeout: 30000,
                });
            }
          expect(bytes).toBeLessThan(item.size! * 0.75);
          const measurement = {
            provider: name,
            kind: key,
            format: 'EPUB',
            fileBytes: item.size,
            firstScreenBytes: bytes,
            requests,
          };
          await app.writeFile(
            'benchmark-' + key + '.json',
            'Books',
            JSON.stringify(measurement, null, 2),
          );
        } finally {
          view.close();
          view.remove();
          await opened.book.destroy?.();
          await (opened.file as ClosableFile | null)?.close?.();
          target.lease.request = request;
        }
      }
    }, 180000);
});
