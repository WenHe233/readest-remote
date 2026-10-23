import { beforeEach, expect, it, vi } from 'vitest';
import { loadDownloadedSourceText } from '@/services/contentSources/localSearch';
import type { SourceBookRef } from '@/services/contentSources/catalog';
import type { Book } from '@/types/book';
import { searchLibraryBooks } from '@/services/librarySearchService';
const records = vi.hoisted(() => new Map<string, unknown>());
const reads = vi.hoisted(() => [] as string[]);
vi.mock('@/services/plugins/persistence', () => ({
  readPluginRecord: async (key: string) => {
    reads.push(key);
    return records.get(key);
  },
}));
vi.mock('@/services/contentSources/catalog', () => ({
  sourceBookHash: () => 'book',
  getSourceBookRef: (book: Book) => book.sourceBook,
}));
vi.mock('@/utils/md5', () => ({ md5: (value: string) => value }));
const source = { instanceId: 'instance', work: { id: 'work' } } as SourceBookRef;
beforeEach(() => {
  records.clear();
  reads.length = 0;
});
const collect = async () => {
  const values = [];
  for await (const value of loadDownloadedSourceText(source)) values.push(value);
  return values;
};
it('reads only completed downloaded HTML, without loading a provider or remote chapter', async () => {
  records.set('source-directory:book', {
    entries: [
      { id: 'downloaded', slot: 0, title: 'One' },
      { id: 'online', slot: 1, title: 'Two' },
      { id: 'comic', slot: 2, title: 'Three' },
    ],
  });
  records.set('source-download:book:downloaded', {
    completedAt: 1,
    content: {
      kind: 'html',
      html: '<p>Offline words</p><img src="https://should-not-fetch.example/image">',
    },
  });
  records.set('source-download:book:comic', {
    completedAt: 1,
    content: { kind: 'pages', pages: [] },
  });
  const values = await collect();
  expect(values).toHaveLength(1);
  expect(values[0]?.text).toBe('Offline words');
  expect(values[0]?.chapter.id).toBe('downloaded');
});
it('does not search unfinished downloads', async () => {
  records.set('source-directory:book', { entries: [{ id: 'pending', slot: 0, title: 'One' }] });
  records.set('source-download:book:pending', {
    content: { kind: 'html', html: '<p>Partial</p>' },
  });
  expect(await collect()).toEqual([]);
});
it('yields one chapter at a time and never reads later chapters after the consumer stops', async () => {
  records.set('source-directory:book', {
    entries: [
      { id: 'first', slot: 0, title: 'One' },
      { id: 'later', slot: 1, title: 'Two' },
    ],
  });
  records.set('source-download:book:first', {
    completedAt: 1,
    content: { kind: 'html', html: '<p>First</p>' },
  });
  records.set('source-download:book:later', {
    completedAt: 1,
    content: { kind: 'html', html: '<p>Later</p>' },
  });
  const iterator = loadDownloadedSourceText(source);
  expect(reads).toEqual([]);
  expect((await iterator.next()).value?.text).toBe('First');
  expect(reads).not.toContain('source-download:book:later');
  await iterator.return();
  expect(reads).not.toContain('source-download:book:later');
});
it('returns stable chapter/text anchors from the full-text service without opening remote content', async () => {
  records.set('source-directory:book', { entries: [{ id: 'downloaded', slot: 7, title: 'One' }] });
  records.set('source-download:book:downloaded', {
    completedAt: 1,
    content: { kind: 'html', html: '<p>Offline needle words</p>' },
  });
  const book = {
    hash: 'book',
    sourceBook: { ...source, work: { id: 'work', kind: 'text' } },
  } as Book;
  const forbidden = vi.fn(() => {
    throw new Error('Local source search must not open a book or runtime');
  });
  const app = {
    getBookFileSize: forbidden,
    loadBookContent: forbidden,
    databaseExists: forbidden,
  } as unknown as Parameters<typeof searchLibraryBooks>[0];
  const events = [];
  for await (const event of searchLibraryBooks(app, [book], 'needle')) events.push(event);
  const result = events.find((event) => event.type === 'result');
  expect(result?.type === 'result' && result.result.subitems[0]?.sourceLocator).toMatchObject({
    workId: 'work',
    chapterId: 'downloaded',
    text: { exact: 'needle words', prefix: 'Offline ' },
  });
  expect(forbidden).not.toHaveBeenCalled();
});
