/** Stable across experimental x releases; never reads or migrates the regular app's profile. */
export const APP_STORAGE_PROFILE = 'io.github.wenhe233.readestremote.experimental';
export const profileStorageKey = (key: string): string => `${APP_STORAGE_PROFILE}:${key}`;
// Supabase also uses this logical name for cross-tab broadcast channels and locks.
export const SUPABASE_AUTH_STORAGE_NAME = 'readest-remote-experimental-auth';
export const SUPABASE_AUTH_STORAGE_KEY = profileStorageKey(SUPABASE_AUTH_STORAGE_NAME);
export const profileDatabaseName = profileStorageKey;
export const profileCacheName = profileStorageKey;
export const profileOpfsName = (name: string): string => `${APP_STORAGE_PROFILE}__${name}`;

/** Explicit Storage facade; browser globals and other applications' keys are left untouched. */
export function createProfileStorage(backing: () => Storage | undefined): Storage {
  const prefix = `${APP_STORAGE_PROFILE}:`;
  const keys = (storage: Storage): string[] => {
    const own: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) own.push(key);
    }
    return own;
  };
  return {
    get length() {
      const storage = backing();
      return storage ? keys(storage).length : 0;
    },
    key(index) {
      const storage = backing();
      return storage ? (keys(storage)[index]?.slice(prefix.length) ?? null) : null;
    },
    getItem(key) {
      return backing()?.getItem(profileStorageKey(String(key))) ?? null;
    },
    setItem(key, value) {
      backing()?.setItem(profileStorageKey(String(key)), String(value));
    },
    removeItem(key) {
      backing()?.removeItem(profileStorageKey(String(key)));
    },
    clear() {
      const storage = backing();
      if (storage) for (const key of keys(storage)) storage.removeItem(key);
    },
  };
}

export const profileLocalStorage = createProfileStorage(() =>
  typeof window === 'undefined' ? undefined : globalThis.localStorage,
);
export const profileSessionStorage = createProfileStorage(() =>
  typeof window === 'undefined' ? undefined : globalThis.sessionStorage,
);
