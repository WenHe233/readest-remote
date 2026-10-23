import { describe, expect, it } from 'vitest';
import type { Book } from '@/types/book';
import {
  selectSearchScope,
  matchesSearchScope,
  mergeSourceResults,
} from '@/services/unifiedSearch';

describe('unified library search scopes', () => {
  it('makes local full text exclusive while allowing an empty metadata selection', () => {
    expect(selectSearchScope(['local', 'source:a'], 'text')).toEqual(['text']);
    expect(selectSearchScope(['text'], 'source:a')).toEqual(['source:a']);
    expect(selectSearchScope(['local'], 'local')).toEqual([]);
  });

  it('keeps imported books separate from source favorites and synchronized libraries', () => {
    const local = { hash: 'local', title: 'Same' } as Book;
    const source = { ...local, sourceBook: { instanceId: 'a' } } as Book;
    const remote = {
      ...local,
      externalSource: { connectionId: 'b', item: { libraryId: 'c' } },
    } as Book;
    expect(matchesSearchScope(local, { id: 'local', kind: 'local', name: 'Local' })).toBe(true);
    expect(matchesSearchScope(source, { id: 'local', kind: 'local', name: 'Local' })).toBe(false);
    expect(matchesSearchScope(remote, { id: 'local', kind: 'local', name: 'Local' })).toBe(false);
    expect(
      matchesSearchScope(remote, {
        id: 'r',
        kind: 'library',
        name: 'Remote',
        connectionId: 'b',
        libraryId: 'c',
      }),
    ).toBe(true);
  });

  it('deduplicates only stable IDs within a source, never titles across sources', () => {
    const work = { id: '1', title: 'Same title', author: '', kind: 'comic' as const };
    const original = [{ instanceId: 'a', work }];
    expect(
      mergeSourceResults(original, [
        { instanceId: 'a', work },
        { instanceId: 'b', work },
      ]),
    ).toHaveLength(2);
    expect(
      mergeSourceResults(original, [{ instanceId: 'a', work: { ...work, id: '2' } }]),
    ).toHaveLength(2);
  });
});
