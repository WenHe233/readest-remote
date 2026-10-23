import type { Book } from '@/types/book';

/** Source instances and their books remain device-local in the first experimental release. */
export const isSourceBook = (book: Book): boolean =>
  book.format === 'SOURCE_TEXT' || book.format === 'SOURCE_COMIC' || !!book.sourceBook;
