import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { ensureSourceCover } from '@/services/contentSources/covers';
import { beginManualCoverWrite, withBookCoverWrite } from '@/services/bookCoverWrites';
const state = vi.hoisted(() => ({ load: vi.fn(), books: [] as Book[] }));
vi.mock('@/utils/book', () => ({
  getCoverFilename: (book: Book) => `${book.hash}/cover.png`,
  getDir: (book: Book) => book.hash,
}));
vi.mock('@/services/contentSources/catalog', () => ({
  getSourceBookRef: (book: Book) => book.sourceBook,
  loadSourceResource: state.load,
}));
vi.mock('@/store/libraryStore', () => ({
  useLibraryStore: {
    getState: () => ({
      library: state.books,
      setLibrary: (books: Book[]) => {
        state.books = books;
      },
      getBookByHash: (hash: string) => state.books.find((book) => book.hash === hash),
    }),
  },
}));
const book = () =>
  ({
    hash: 'a',
    title: 'Title',
    sourceBook: {
      instanceId: 'source',
      pluginId: 'plugin',
      fingerprint: 'a'.repeat(64),
      work: {
        id: 'work',
        title: 'Title',
        author: '',
        kind: 'comic',
        cover: { id: 'cover', url: 'https://example.org/cover' },
      },
    },
  }) as Book;
const app = () => ({
  exists: vi.fn(async () => false),
  createDir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
  generateCoverImageUrl: vi.fn(async () => 'asset://cover'),
  saveLibraryBooks: vi.fn(async () => {}),
});
beforeEach(() => {
  state.books = [book()];
  state.load.mockReset().mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
});
describe('network book cover persistence', () => {
  it('loads through the source broker, persists bytes and publishes the local cover', async () => {
    const host = app();
    await ensureSourceCover(host, state.books[0]!);
    expect(state.load).toHaveBeenCalledOnce();
    expect(host.writeFile).toHaveBeenCalledOnce();
    expect(state.books[0]?.coverImageUrl).toBe('asset://cover');
    expect(host.saveLibraryBooks).not.toHaveBeenCalled();
  });
  it('uses an existing cover offline without starting a source runtime', async () => {
    const host = app();
    host.exists.mockResolvedValue(true);
    await ensureSourceCover(host, state.books[0]!);
    expect(state.load).not.toHaveBeenCalled();
    expect(state.books[0]?.coverImageUrl).toBe('asset://cover');
  });
  it('preserves a manually edited cover', async () => {
    const host = app();
    state.books[0]!.coverUpdatedAt = 1;
    await ensureSourceCover(host, state.books[0]!);
    expect(state.load).not.toHaveBeenCalled();
    expect(host.writeFile).not.toHaveBeenCalled();
  });
  it('does not overwrite a manual cover saved while the source image is being prepared', async () => {
    const host = app();
    host.createDir.mockImplementation(async () => {
      state.books[0]!.coverUpdatedAt = 2;
    });
    await ensureSourceCover(host, state.books[0]!);
    expect(host.writeFile).not.toHaveBeenCalled();
  });
  it('lets a manual cover win when an automatic file write is already in flight', async () => {
    const host = app();
    let finish!: () => void;
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let file = '';
    host.writeFile.mockImplementation(async () => {
      started();
      await gate;
      file = 'automatic';
    });
    const automatic = ensureSourceCover(host, state.books[0]!);
    await writing;
    beginManualCoverWrite('a');
    const manual = withBookCoverWrite('a', async () => {
      file = 'manual';
    });
    finish();
    await Promise.all([automatic, manual]);
    expect(file).toBe('manual');
  });
  it('invalidates a queued source cover before a manual write has published metadata', async () => {
    const host = app();
    host.createDir.mockImplementation(async () => {
      beginManualCoverWrite('a');
    });
    await ensureSourceCover(host, state.books[0]!);
    expect(host.writeFile).not.toHaveBeenCalled();
  });
});
