import type { BookFormat } from '@/types/book';
import type { BookDoc, BookMetadata } from '@/libs/document';
import { trackWidePages, type WidePagesOptions } from '@/utils/spread';

export const openPageStreamBook = async (
  data: { count: number; title: string; author: string },
  loadPage: (index: number) => Promise<Blob>,
  widePages?: WidePagesOptions,
): Promise<{ book: BookDoc; format: BookFormat }> => {
  const entries = Array.from({ length: data.count }).map((_, i) => ({
    filename: `${i.toString().padStart(4, '0')}.jpg`,
    directory: false,
    size: 0,
  }));
  const loader = {
    entries,
    loadText: async () => null,
    loadBlob: async (name: string) => {
      const i = parseInt(name.split('.')[0] || '0', 10);
      return loadPage(i);
    },
    getSize: () => 0,
    getComment: async () => null,
  };
  const { makeComicBook } = await import('foliate-js/comic-book.js');
  // makeComicBook only consults `file.name` as a fallback title; we override
  // metadata from `data` regardless, so a name-only stand-in is sufficient.
  // Each page streams in on its own request, so it is measured as it arrives.
  const pages = widePages && trackWidePages(loader, widePages.onFound);
  const rawComicBook = await makeComicBook(pages?.loader ?? loader, { name: data.title });
  pages?.attach(rawComicBook.sections, widePages?.known ?? []);
  const book = {
    ...rawComicBook,
    dir: 'auto',
    metadata: {
      ...(rawComicBook.metadata || {}),
      title: data.title,
      author: data.author,
    } as BookMetadata,
  } as BookDoc;
  return { book, format: 'CBZ' };
};
