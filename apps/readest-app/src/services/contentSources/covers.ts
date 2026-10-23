import type { Book } from '@/types/book';
import type { AppService } from '@/types/system';
import { useLibraryStore } from '@/store/libraryStore';
import { getCoverFilename, getDir } from '@/utils/book';
import { getSourceBookRef, loadSourceResource, type SourceBookRef } from './catalog';
import { bookCoverWriteVersion, withBookCoverWrite } from '../bookCoverWrites';

export type SourceCoverHost = Pick<
  AppService,
  'exists' | 'createDir' | 'writeFile' | 'generateCoverImageUrl'
>;
const pending = new Map<string, Promise<void>>();
let active = 0;
const waiting: Array<() => void> = [];
async function withCoverSlot<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (active >= 3) await new Promise<void>((resolve) => waiting.push(resolve));
  else active++;
  try {
    signal?.throwIfAborted();
    return await operation();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}
export function loadSourceCover(source: SourceBookRef, signal?: AbortSignal): Promise<Blob> {
  return withCoverSlot(async () => {
    if (!source.work.cover) throw new Error('Source has no cover');
    const blob = await loadSourceResource(source, source.work.cover, undefined, signal);
    if (!/^image\/(png|jpe?g|webp|gif|avif|bmp)$/iu.test(blob.type) || blob.size > 8 * 1024 * 1024)
      throw new Error('Invalid source cover');
    return blob;
  }, signal);
}
export function ensureSourceCover(app: SourceCoverHost, book: Book): Promise<void> {
  const existing = pending.get(book.hash);
  if (existing) return existing;
  const operation = (async () => {
    const source = getSourceBookRef(book);
    if (!source?.work.cover || book.coverUpdatedAt) return;
    const version = bookCoverWriteVersion(book.hash);
    if (!(await app.exists(getCoverFilename(book), 'Books'))) {
      const blob = await loadSourceCover(source);
      const bytes = await blob.arrayBuffer();
      await app.createDir(getDir(book), 'Books', true);
      const written = await withBookCoverWrite(book.hash, async () => {
        const current = useLibraryStore.getState().getBookByHash(book.hash);
        if (
          !current ||
          current.deletedAt ||
          current.coverUpdatedAt ||
          version !== bookCoverWriteVersion(book.hash)
        )
          return false;
        await app.writeFile(getCoverFilename(book), 'Books', bytes);
        return version === bookCoverWriteVersion(book.hash);
      });
      if (!written) return;
    }
    const current = useLibraryStore.getState().getBookByHash(book.hash);
    if (!current || current.deletedAt || current.coverUpdatedAt) return;
    const coverImageUrl = await app.generateCoverImageUrl(current);
    if (version !== bookCoverWriteVersion(book.hash)) return;
    const books = useLibraryStore
      .getState()
      .library.map((item) =>
        item.hash === book.hash && !item.coverUpdatedAt
          ? { ...item, coverImageUrl, coverDownloadedAt: Date.now() }
          : item,
      );
    useLibraryStore.getState().setLibrary(books);
  })().finally(() => pending.delete(book.hash));
  pending.set(book.hash, operation);
  return operation;
}
