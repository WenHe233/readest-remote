import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import {
  bookLibraryId,
  filterLibraryBooks,
  libraryFilterOptions,
  toggleLibraryFilter,
} from '@/services/libraryFilter';

const local = { hash: 'local', title: 'Local' } as Book;
const source = {
  hash: 'source',
  sourceBook: { instanceId: 'source-one' },
} as Book;
const remote = {
  hash: 'remote',
  metadata: { externalSource: { connectionId: 'server', item: { libraryId: 'comics/1' } } },
} as Book;

describe('library view filtering', () => {
  it('reuses stable source and library identities, including metadata-only legacy books', () => {
    expect(bookLibraryId(local)).toBe('local');
    expect(bookLibraryId(source)).toBe('source:source-one');
    expect(bookLibraryId(remote)).toBe('library:server:comics%2F1');
    expect(bookLibraryId({ ...local, filePath: 'abs://audio/123' })).toBe('abs:audio');
  });

  it('keeps all as the default, supports unions and treats empty or missing IDs as empty', () => {
    const books = [local, source, remote];
    expect(filterLibraryBooks(books, undefined)).toBe(books);
    expect(filterLibraryBooks(books, null)).toBe(books);
    expect(filterLibraryBooks(books, ['local', 'source:source-one'])).toEqual([local, source]);
    expect(filterLibraryBooks(books, [])).toEqual([]);
    expect(filterLibraryBooks(books, ['source:removed'])).toEqual([]);
    expect(books).toEqual([local, source, remote]);
  });

  it('retains saved books after a source or library is removed and excludes tombstones', () => {
    const options = libraryFilterOptions(
      [
        local,
        source,
        remote,
        { ...source, hash: 'gone', sourceBook: { instanceId: 'gone' }, deletedAt: 1 } as Book,
      ],
      [
        { id: 'local', name: 'Local imports' },
        { id: 'source:disabled', name: 'Disabled source' },
      ],
    );
    expect(options.map((option) => option.id)).toEqual([
      'local',
      'source:disabled',
      'source:source-one',
      'library:server:comics%2F1',
    ]);
    expect(
      filterLibraryBooks(
        [source, remote],
        options.map((option) => option.id),
      ),
    ).toEqual([source, remote]);
  });

  it('toggles an item off from all, adds further selections and preserves explicitly empty selections', () => {
    const options = ['local', 'source:source-one', 'library:server:comics%2F1'];
    expect(toggleLibraryFilter(undefined, 'local', options)).toEqual(options.slice(1));
    expect(toggleLibraryFilter(['local'], 'source:source-one', options)).toEqual([
      'local',
      'source:source-one',
    ]);
    expect(toggleLibraryFilter(['local'], 'local', options)).toEqual([]);
    expect(toggleLibraryFilter([], 'local', options)).toEqual(['local']);
  });
});
