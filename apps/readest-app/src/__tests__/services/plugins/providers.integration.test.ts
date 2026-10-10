// @vitest-environment node
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { kavitaPlugin, kavitaTime } from '../../../../../../plugins/kavita/src/plugin';
import { komgaPlugin } from '../../../../../../plugins/komga/src/plugin';
import {
  parsePluginOperationResult,
  type HttpRequest,
  type HttpResponse,
  type LibraryContext,
  type PluginWorkerOperationContext,
  type RemoteBook,
} from '@readest/plugin-sdk';

describe('Kavita UTC timestamp regression', () => {
  it('treats the server empty-progress date as no timestamp', () =>
    expect(kavitaTime('0001-01-01T00:00:00')).toBe(0));
  it('treats zone-less server timestamps as UTC', () =>
    expect(kavitaTime('2026-08-24T07:25:16.112')).toBe(Date.parse('2026-08-24T07:25:16.112Z')));
});
const enabled = process.env['READEST_PLUGIN_INTEGRATION'] === '1';
describe.runIf(enabled)('real external library APIs', () => {
  for (const [name, handlers] of [
    ['kavita', kavitaPlugin],
    ['komga', komgaPlugin],
  ] as const) {
    it(name + ' browses all libraries and resolves every supported format', async () => {
      const secrets = JSON.parse(
        readFileSync(resolve('../../../.v2-local/test-credentials.json'), 'utf8'),
      ) as Record<string, { url: string; apiKey: string }>;
      const server = secrets[name]!;
      const context: LibraryContext = {
        sourceId: name,
        connection: 'test-connection',
        config: {},
        secrets: { apiKey: 'private-slot' },
      };
      const host: PluginWorkerOperationContext = {
        signal: new AbortController().signal,
        progress: () => {},
        async call(capability, payload) {
          if (capability !== 'http.request') throw new Error('Unexpected capability');
          const req = payload as HttpRequest;
          const url = new URL(server.url + req.path);
          for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
          const headers = new Headers(req.headers);
          for (const binding of req.auth ?? []) {
            expect(binding.secret).toBe('private-slot');
            if (binding.in === 'header') headers.set(binding.name, server.apiKey);
            else url.searchParams.set(binding.name, server.apiKey);
          }
          if (req.json) headers.set('content-type', 'application/json');
          const response = await fetch(url, {
            method: req.method ?? 'GET',
            headers,
            body: req.json ? JSON.stringify(req.json) : undefined,
          });
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            bytes: new Uint8Array(await response.arrayBuffer()),
          } satisfies HttpResponse;
        },
      };
      expect(await handlers['library.testConnection']!({ context }, host)).toHaveProperty('name');
      const libraries = await handlers['library.listLibraries']!({ context }, host);
      expect(libraries.length).toBeGreaterThan(0);
      const books: RemoteBook[] = [];
      let cursor: string | undefined;
      let completed = false;
      for (let page = 0; page < 1000; page++) {
        const result = parsePluginOperationResult(
          'library.syncCatalog',
          await handlers['library.syncCatalog']!(
            { context, libraryIds: libraries.map((l) => l.id), cursor },
            host,
          ),
        );
        books.push(...result.books);
        if (result.complete) {
          completed = true;
          break;
        }
        cursor = result.nextCursor;
        expect(cursor).toBeTruthy();
      }
      expect(completed).toBe(true);
      expect(books.length).toBeGreaterThan(100);
      const examples: Record<string, RemoteBook> = {};
      for (const format of ['EPUB', 'PDF', 'CBZ'] as const) {
        const book = books.find((b) => b.format === format);
        expect(book, format + ' catalog support').toBeTruthy();
        if (!book) continue;
        examples[format] = book;
        const current = await handlers['library.getBook']({ context, book }, host);
        expect(current.id).toBe(book.id);
        expect(current.size).toBe(book.size);
        const content = parsePluginOperationResult(
          'library.resolveContent',
          await handlers['library.resolveContent']!({ context, book }, host),
        );
        expect(content.kind).toBe(
          name === 'kavita' && format !== 'CBZ'
            ? 'remote-file'
            : format === 'EPUB'
              ? 'epub-resources'
              : 'pages',
        );
        const cover = await handlers['library.getCover']!({ context, book }, host);
        expect(cover).toHaveProperty('path');
        const progress = await handlers['library.pullProgress']!({ context, book }, host);
        parsePluginOperationResult('library.pullProgress', progress);
        const position =
          format === 'EPUB'
            ? {
                kind: 'epub' as const,
                fraction: 0.4,
                modified: Date.now(),
                spineIndex: 2,
                href: 'OEBPS/text00002.html',
                xpath: '/body/DocFragment[3]/body/p[1]',
                fragment: 'body > p:nth-of-type(1)',
                sectionProgress: 0.25,
              }
            : { kind: 'page' as const, fraction: 0.2, modified: Date.now(), pageIndex: 2 };
        await handlers['library.pushProgress']!({ context, book, progress: position }, host);
        const saved = await handlers['library.pullProgress']!({ context, book }, host);
        expect(saved?.kind).toBe(position.kind);
        if (format !== 'EPUB') expect(saved?.pageIndex).toBe(2);
        else if (name === 'kavita') expect(saved?.xpath).toBe(position.xpath);
        else {
          expect(saved?.href).toBe(position.href);
          expect(saved?.fragment).toBe(position.fragment);
        }
      }
      const large = books
        .filter((book) => book.format === 'EPUB')
        .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];
      if (large) examples['LARGE_EPUB'] = large;
      if (name === 'kavita') {
        const multiple = books.find(
          (book) => book.format === 'EPUB' && Number(book.data?.['fileCount']) > 1,
        );
        if (multiple) examples['MULTI_EPUB'] = multiple;
      }
      const out = resolve('../../.v2-artifacts/verification');
      mkdirSync(out, { recursive: true });
      writeFileSync(
        resolve(out, name + '-catalog.json'),
        JSON.stringify(
          {
            count: books.length,
            formats: Object.fromEntries(
              ['EPUB', 'PDF', 'CBZ'].map((f) => [f, books.filter((b) => b.format === f).length]),
            ),
            examples,
          },
          null,
          2,
        ),
      );
    }, 180_000);
  }
});
