import type { Work } from '@readest/plugin-sdk';
import type { Book } from '@/types/book';
import { profileLocalStorage } from './browserProfile';

export interface SearchScope {
  id: string;
  kind: 'local' | 'library' | 'source';
  name: string;
  connectionId?: string;
  libraryId?: string;
  instanceId?: string;
}
export interface SourceSearchResult {
  instanceId: string;
  work: Work;
}
const KEY = 'library-search-scopes';
export function loadSearchScopes(): string[] {
  try {
    const value: unknown = JSON.parse(profileLocalStorage?.getItem(KEY) ?? 'null');
    if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
      return value.includes('text') ? ['text'] : [...new Set(value)];
  } catch {
    /* A missing or invalid preference starts with local imports. */
  }
  return ['local'];
}
export function saveSearchScopes(scopes: string[]): void {
  profileLocalStorage?.setItem(KEY, JSON.stringify(scopes));
}
export function selectSearchScope(current: string[], id: string): string[] {
  if (id === 'text') return ['text'];
  const next = current.filter((item) => item !== 'text');
  return next.includes(id) ? next.filter((item) => item !== id) : [...next, id];
}
export function matchesSearchScope(book: Book, scope: SearchScope): boolean {
  const external = book.externalSource ?? book.metadata?.externalSource;
  const source = book.sourceBook ?? book.metadata?.sourceBook;
  if (scope.kind === 'local') return !external && !source && !book.filePath?.startsWith('abs://');
  if (scope.kind === 'source') return source?.instanceId === scope.instanceId;
  return (
    !!external &&
    external.connectionId === scope.connectionId &&
    external.item.libraryId === scope.libraryId
  );
}
export function mergeSourceResults(
  previous: SourceSearchResult[],
  incoming: SourceSearchResult[],
): SourceSearchResult[] {
  const items = new Map(
    previous.map((item) => [JSON.stringify([item.instanceId, item.work.id]), item]),
  );
  for (const item of incoming) items.set(JSON.stringify([item.instanceId, item.work.id]), item);
  return [...items.values()];
}
export function searchFailureCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return /^[A-Z][A-Z0-9_]{1,127}$/u.test(code) ? code : 'SOURCE_OPERATION_FAILED';
}
