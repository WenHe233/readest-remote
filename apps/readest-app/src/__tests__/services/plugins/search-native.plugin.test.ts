import { describe, expect, it } from 'vitest';
import type { RemoteBook } from '@readest/plugin-sdk';
import { verifyPluginPackage } from '@/services/plugins/package';
import { installPlugin } from '@/services/plugins/manager';
import { savePluginConnection } from '@/services/plugins/connections';
import { reconcileExternalCatalog } from '@/services/plugins/library';
import { openExternalBook } from '@/services/plugins/content';
import {
  createLibrarySearchSession,
  resolveSearchResultCfis,
  searchLibraryBooks,
} from '@/services/librarySearchService';
import type { ClosableFile } from '@/utils/file';

declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_SERVERS__: Record<string, { url: string; apiKey: string }> | null;
declare const __PLUGIN_TEST_BOOKS__: Record<string, Record<string, RemoteBook>>;

describe.runIf(!!__PLUGIN_TEST_SERVERS__)('native streaming full-book search', () => {
  for (const provider of ['kavita', 'komga']) {
    for (const format of ['EPUB', 'PDF', 'CBZ']) {
      it(`${provider} searches remote ${format} or identifies an image stream without a local original`, async () => {
        const server = __PLUGIN_TEST_SERVERS__![provider]!;
        const pkg = await verifyPluginPackage(
          Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__[provider]!), (c) => c.charCodeAt(0)),
        );
        await installPlugin(pkg, true);
        const connection = {
          id: crypto.randomUUID(),
          pluginId: pkg.manifest.id,
          fingerprint: pkg.fingerprint,
          sourceId: provider,
          name: 'Search test',
          url: server.url,
          config: {},
          libraryIds: [],
          secretNames: ['apiKey'],
          addedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await savePluginConnection(connection, { apiKey: server.apiKey }, false);
        const item = Object.values(__PLUGIN_TEST_BOOKS__[provider]!).find(
          (b) => b.format === format,
        )!;
        expect(item).toBeTruthy();
        const book = reconcileExternalCatalog(connection, [item], [])[0]!;
        const { NativeAppService } = await import('@/services/nativeAppService');
        const app = new NativeAppService(
          process.env['CWD'] + '/.readest-test-sandbox-tauri/search-' + provider,
        );
        await app.init();
        expect(await app.getBookFileSize(book)).toBeNull();
        const opened = await openExternalBook(app, book);
        const session = createLibrarySearchSession(app, { book, bookDoc: opened.book });
        try {
          if (!opened.book.sections.some((s) => typeof s.createDocument === 'function')) {
            const events = [];
            for await (const event of searchLibraryBooks(app, [book], 'needle', { session }))
              events.push(event);
            expect(events).toContainEqual(
              expect.objectContaining({ type: 'book-skipped', reason: 'no-text' }),
            );
            return;
          }
          let term: string | undefined;
          for (const section of opened.book.sections) {
            const doc = await section.createDocument?.();
            term = doc?.body?.textContent?.match(/[\p{L}]{3,8}/u)?.[0];
            if (term) break;
          }
          if (!term) {
            const events = [];
            for await (const event of searchLibraryBooks(app, [book], 'needle', { session }))
              events.push(event);
            expect(events).toContainEqual(
              expect.objectContaining({ type: 'book-skipped', reason: 'no-text' }),
            );
            return;
          }
          let matches = 0;
          let scanned = 0;
          for await (const event of searchLibraryBooks(app, [book], term!, {
            session,
            maxResultsPerBook: Infinity,
          })) {
            if (event.type === 'book-error' || event.type === 'book-skipped')
              throw new Error(JSON.stringify(event));
            if (event.type === 'progress') scanned = event.sectionsCompleted;
            if (event.type === 'result') {
              matches += event.result.subitems.length;
              const cfis = await resolveSearchResultCfis(
                session,
                book,
                event.result.subitems.slice(0, 1).map((m) => m.locator),
              );
              expect(cfis[0]?.cfi).toMatch(/^epubcfi/);
            }
          }
          expect(matches).toBeGreaterThan(0);
          expect(scanned).toBe(opened.book.sections.length);
          await session.close();
          // Closing a borrowed session must leave the reader's document usable.
          expect(await opened.book.sections[0]!.createDocument!()).toBeTruthy();
          expect(await app.getBookFileSize(book)).toBeNull();
        } finally {
          await session.close();
          await opened.book.destroy?.();
          await (opened.file as ClosableFile | null)?.close?.();
        }
      }, 300000);
    }
  }
});
