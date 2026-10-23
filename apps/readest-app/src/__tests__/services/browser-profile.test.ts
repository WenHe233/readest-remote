import { describe, expect, it } from 'vitest';
import {
  APP_STORAGE_PROFILE,
  createProfileStorage,
  profileDatabaseName,
  profileOpfsName,
  profileStorageKey,
} from '@/services/browserProfile';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
describe('experimental browser profile', () => {
  it('does not inherit stable tokens/settings and clears only its own namespace', () => {
    const raw = memoryStorage();
    raw.setItem('token', 'stable-token');
    raw.setItem('themeMode', 'dark');
    const experiment = createProfileStorage(() => raw);
    expect(experiment.getItem('token')).toBeNull();
    expect(experiment.getItem('themeMode')).toBeNull();
    experiment.setItem('token', 'experimental-token');
    experiment.setItem('themeMode', 'light');
    expect(raw.getItem('token')).toBe('stable-token');
    expect(raw.getItem(profileStorageKey('token'))).toBe('experimental-token');
    expect(experiment.length).toBe(2);
    expect([experiment.key(0), experiment.key(1)]).toEqual(['token', 'themeMode']);
    experiment.clear();
    expect(experiment.length).toBe(0);
    expect(raw.getItem('token')).toBe('stable-token');
    expect(raw.getItem('themeMode')).toBe('dark');
  });
  it('uses a version-independent application identity and portable OPFS names', () => {
    expect(APP_STORAGE_PROFILE).toBe('io.github.wenhe233.readestremote.experimental');
    expect(profileDatabaseName('AppFileSystem')).not.toBe('AppFileSystem');
    expect(profileDatabaseName('readest-external-plugins-v2')).not.toBe(
      'readest-external-plugins-v2',
    );
    expect(profileOpfsName('data_book.db')).not.toBe('data_book.db');
    expect(profileOpfsName('data_book.db')).not.toMatch(/[/\\:]/);
  });
  it('provides empty reads on the server without changing browser globals', () => {
    const unavailable = createProfileStorage(() => undefined);
    expect(unavailable.getItem('token')).toBeNull();
    expect(unavailable.length).toBe(0);
    expect(() => unavailable.setItem('token', 'value')).not.toThrow();
  });
});
