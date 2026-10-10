import { describe, expect, it } from 'vitest';
import { resolvePluginUrl } from '@/services/plugins/httpBroker';
import { validateByteRange } from '@/services/plugins/content';
import { progressDecision, resolvePluginPosition } from '@/services/plugins/progress';
import type { BookDoc } from '@/libs/document';
import type { FoliateView } from '@/types/view';
import { reconcileExternalCatalog } from '@/services/plugins/library';
import type { PluginConnection } from '@/services/plugins/types';
import type { RemoteBook, ReadingPosition } from '@readest/plugin-sdk';
const connection: PluginConnection = {
  id: '11111111-1111-4111-8111-111111111111',
  pluginId: 'test.source',
  fingerprint: 'a'.repeat(64),
  sourceId: 'library',
  name: 'Books',
  url: 'http://localhost:5001/kavita',
  config: {},
  libraryIds: ['1'],
  secretNames: ['apiKey'],
  addedAt: 1,
  updatedAt: 1,
};
const item: RemoteBook = {
  id: '7',
  libraryId: '1',
  title: 'Remote title',
  author: 'Author',
  format: 'EPUB',
  revision: '1',
  size: 100,
};
describe('external library host invariants', () => {
  it('restores fixed-layout pages without requiring an EPUB CFI resolver', async () => {
    const doc = { sections: Array.from({ length: 10 }) } as BookDoc;
    const view = {} as FoliateView;
    expect(
      await resolvePluginPosition(
        { kind: 'page', pageIndex: 3, fraction: 0.3, modified: 1 },
        doc,
        view,
      ),
    ).toMatchObject({ pageIndex: 3, approximate: false });
    expect(
      await resolvePluginPosition(
        { kind: 'page', pageIndex: 30, fraction: 1, modified: 1 },
        doc,
        view,
      ),
    ).toMatchObject({ pageIndex: 9, approximate: true });
  });
  it('keeps configured base paths and rejects URL and traversal escapes', () => {
    expect(resolvePluginUrl(connection.url, '/api/books').href).toBe(
      'http://localhost:5001/kavita/api/books',
    );
    for (const path of [
      '//evil.invalid/book',
      'https://evil.invalid/book',
      '/../admin',
      '/%252e%252e/admin',
      '/a\\b',
    ])
      expect(() => resolvePluginUrl(connection.url, path)).toThrow();
  });
  it('requires exact 206 byte ranges and total size', () => {
    expect(() =>
      validateByteRange(
        new Response(null, { status: 206, headers: { 'content-range': 'bytes 10-19/100' } }),
        10,
        19,
        100,
      ),
    ).not.toThrow();
    for (const [status, range] of [
      [200, 'bytes 10-19/100'],
      [206, 'bytes 0-9/100'],
      [206, 'bytes 10-19/101'],
    ] as const)
      expect(() =>
        validateByteRange(
          new Response(null, { status, headers: { 'content-range': range } }),
          10,
          19,
          100,
        ),
      ).toThrow();
  });
  it('keeps book identity across URL edits and preserves local metadata/offline copies', () => {
    const [first] = reconcileExternalCatalog(connection, [item], [], 10);
    const local = {
      ...first!,
      title: 'Local title',
      metadataUpdatedAt: 11,
      externalDownloadedAt: 12,
    };
    const [next] = reconcileExternalCatalog(
      { ...connection, url: 'https://new.example' },
      [{ ...item, title: 'Server rename' }],
      [local],
      20,
    );
    expect(next?.hash).toBe(first?.hash);
    expect(next?.title).toBe('Local title');
    expect(next?.externalDownloadedAt).toBe(12);
    const [missing] = reconcileExternalCatalog(connection, [], [local]);
    expect(missing?.externalSource?.unavailable).toBe(true);
    expect(missing?.externalDownloadedAt).toBe(12);
    expect(missing?.deletedAt).toBeNull();
  });
  it('asks for divergent newer or approximate progress and restores an empty local book', () => {
    const local: ReadingPosition = { kind: 'epub', fraction: 0.2, modified: 10, cfi: 'precise' };
    expect(progressDecision(null, { kind: 'epub', fraction: 0.7, modified: 20 })).toBe('remote');
    expect(progressDecision(local, { kind: 'epub', fraction: 0.7, modified: 20 })).toBe('ask');
    expect(
      progressDecision(local, { kind: 'epub', fraction: 0.7, modified: 1, approximate: true }),
    ).toBe('ask');
    expect(progressDecision(local, { kind: 'epub', fraction: 0.1, modified: 1 })).toBe('local');
    expect(
      progressDecision(
        { ...local, href: 'chapter.xhtml', fragment: '#paragraph' },
        { kind: 'epub', href: 'chapter.xhtml', fragment: '#paragraph', fraction: 0.6, modified: 1 },
      ),
    ).toBe('local');
    expect(
      progressDecision(
        { kind: 'page', fraction: 0.2, pageIndex: 20, modified: 1 },
        { kind: 'page', fraction: 0.201, pageIndex: 21, modified: 2 },
      ),
    ).toBe('ask');
  });
});
