import type { Book } from '@/types/book';
import { parseAbsFilePath } from '@/utils/audiobook';
import { stubTranslation as _ } from '@/utils/misc';

export interface LibraryFilterOption {
  id: string;
  name: string;
}

export type LibraryFilter = string[] | null | undefined;

/** Share search scope identities without tying saved books to an installed provider. */
export function bookLibraryId(book: Book): string {
  const source = book.sourceBook ?? book.metadata?.sourceBook;
  if (source) return `source:${source.instanceId}`;
  const external = book.externalSource ?? book.metadata?.externalSource;
  if (external)
    return `library:${external.connectionId}:${encodeURIComponent(external.item.libraryId)}`;
  const abs = parseAbsFilePath(book.filePath);
  return abs ? `abs:${abs.serverId}` : 'local';
}

export function filterLibraryBooks(books: Book[], selected: LibraryFilter): Book[] {
  if (selected == null) return books;
  const ids = new Set(selected);
  return books.filter((book) => ids.has(bookLibraryId(book)));
}

export function libraryFilterOptions(
  books: Book[],
  known: LibraryFilterOption[],
  translate: (text: string) => string = (text) => text,
): LibraryFilterOption[] {
  const options = new Map(known.map((option) => [option.id, option]));
  for (const book of books) {
    if (book.deletedAt) continue;
    const id = bookLibraryId(book);
    if (options.has(id)) continue;
    const source = book.sourceBook ?? book.metadata?.sourceBook;
    const external = book.externalSource ?? book.metadata?.externalSource;
    const name = source
      ? `${translate(_('Unavailable source'))} (${source.instanceId.slice(0, 8)})`
      : external
        ? `${translate(_('Unavailable library'))} (${external.connectionId.slice(0, 8)} / ${external.item.libraryId})`
        : id.startsWith('abs:')
          ? `Audiobookshelf (${id.slice(4, 12)})`
          : translate(_('Local imports'));
    options.set(id, { id, name });
  }
  return [...options.values()];
}

export function toggleLibraryFilter(
  selected: LibraryFilter,
  id: string,
  available: string[],
): string[] {
  const current = selected ?? available;
  return current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
}
