import { profileLocalStorage } from '@/services/browserProfile';
const STORAGE_KEY = 'search-history-library';
const MAX_SEARCH_HISTORY = 10;

export const loadLibrarySearchHistory = (): string[] => {
  try {
    const saved = profileLocalStorage.getItem(STORAGE_KEY);
    return saved ? (JSON.parse(saved) as string[]) : [];
  } catch {
    return [];
  }
};

export const addLibrarySearchHistory = (term: string): void => {
  const trimmed = term.trim();
  if (!trimmed) return;
  const updated = [trimmed, ...loadLibrarySearchHistory().filter((t) => t !== trimmed)].slice(
    0,
    MAX_SEARCH_HISTORY,
  );
  try {
    profileLocalStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    /* best effort */
  }
};

export const clearLibrarySearchHistory = (): void => {
  try {
    profileLocalStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best effort */
  }
};
