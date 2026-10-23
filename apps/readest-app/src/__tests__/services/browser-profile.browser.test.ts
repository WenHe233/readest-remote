import { describe, expect, it } from 'vitest';
import { WebAppService } from '@/services/webAppService';
import { readPluginRecord, writePluginRecords } from '@/services/plugins/persistence';
import {
  clearConnectionSecrets,
  getConnectionSecrets,
  setConnectionSecrets,
} from '@/services/plugins/vault';
import { createOpfsPackFs } from '@/services/tts/providers/opfsPackFs';
import { APP_STORAGE_PROFILE, profileOpfsName } from '@/services/browserProfile';
import { getLibraryFilename } from '@/utils/book';

async function openStableDatabase(name: string, store: string, keyPath?: string) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(store, keyPath ? { keyPath } : undefined);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function put(db: IDBDatabase, store: string, value: unknown, key?: string) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function read(db: IDBDatabase, store: string, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function writeFile(dir: FileSystemDirectoryHandle, name: string, text: string) {
  const file = await dir.getFileHandle(name, { create: true });
  const writer = await file.createWritable();
  await writer.write(text);
  await writer.close();
}
async function readFile(dir: FileSystemDirectoryHandle, name: string) {
  return (await (await dir.getFileHandle(name)).getFile()).text();
}

describe('same-origin stable and experimental browser profiles', () => {
  it('opens an empty experimental bookshelf and keeps stable settings/positions after experiment writes/deletes', async () => {
    const stable = await openStableDatabase('AppFileSystem', 'files', 'path');
    const app = new WebAppService();
    const fixtures = [
      ['Readest/Books/' + getLibraryFilename(), '[{"hash":"stable-book","title":"Stable"}]'],
      ['Readest/settings.json', '{"theme":"stable"}'],
      ['Readest/Books/profile-test/config.json', '{"location":"stable-cfi"}'],
    ];
    try {
      for (const [path, content] of fixtures) await put(stable, 'files', { path, content });
      expect(await app.loadLibraryBooks()).toEqual([]);
      for (const [path, content] of fixtures) {
        expect(await app.fs.exists(path!, 'None')).toBe(false);
        await app.fs.writeFile(path!, 'None', 'experimental');
        expect(await app.fs.readFile(path!, 'None', 'text')).toBe('experimental');
        await app.fs.removeFile(path!, 'None');
        expect(await read(stable, 'files', path!)).toEqual({ path, content });
      }
    } finally {
      stable.close();
    }
  });

  it('isolates installed package records and encrypted credentials with the same connection id', async () => {
    const stable = await openStableDatabase('readest-external-plugins-v2', 'records');
    const id = 'profile-shared-connection';
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      new TextEncoder().encode('{"token":"stable"}'),
    );
    try {
      await put(stable, 'records', key, 'vault:key');
      await put(stable, 'records', { iv, data }, 'vault:' + id);
      await put(stable, 'records', { version: 'stable' }, 'installed:profile-test');
      expect(await getConnectionSecrets(id)).toEqual({});
      expect(await readPluginRecord('installed:profile-test')).toBeUndefined();
      await setConnectionSecrets(id, { token: 'experimental' });
      await writePluginRecords({ 'installed:profile-test': { version: 'experiment' } });
      expect(await getConnectionSecrets(id)).toEqual({ token: 'experimental' });
      await clearConnectionSecrets(id);
      await writePluginRecords({}, ['installed:profile-test']);
      expect(await read(stable, 'records', 'installed:profile-test')).toEqual({
        version: 'stable',
      });
      const row = (await read(stable, 'records', 'vault:' + id)) as {
        iv: Uint8Array;
        data: ArrayBuffer;
      };
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer> },
        key,
        row.data,
      );
      expect(new TextDecoder().decode(plaintext)).toBe('{"token":"stable"}');
    } finally {
      stable.close();
    }
  });

  it('installs and removes experimental SQLite files and TTS packs without modifying stable OPFS entries', async () => {
    const root = await navigator.storage.getDirectory();
    const app = new WebAppService();
    const basename = 'profile-isolation.db';
    const stableName = 'Readest_' + basename;
    await writeFile(root, stableName, 'stable database');
    await writeFile(root, stableName + '-wal', 'stable journal');
    const stablePacks = await root.getDirectoryHandle('profile-packs', { create: true });
    await writeFile(stablePacks, 'same.pack', 'stable pack');
    try {
      expect(await app.databaseExists(basename, 'Data')).toBe(false);
      await app.installDatabase(basename, 'Data', new File(['experiment database'], basename));
      expect(await app.databaseExists(basename, 'Data')).toBe(true);
      expect(await readFile(root, profileOpfsName(stableName))).toBe('experiment database');
      await app.deleteDatabase(basename, 'Data');
      expect(await app.databaseExists(basename, 'Data')).toBe(false);
      expect(await readFile(root, stableName)).toBe('stable database');
      expect(await readFile(root, stableName + '-wal')).toBe('stable journal');
      const packs = await createOpfsPackFs('profile-packs');
      expect(packs).toBeDefined();
      expect(await packs!.list()).toEqual([]);
      await packs!.write('same.pack', new TextEncoder().encode('experiment pack'));
      expect(new TextDecoder().decode(await packs!.readRange('same.pack', 0, 15))).toBe(
        'experiment pack',
      );
      await packs!.remove('same.pack');
      expect(await readFile(stablePacks, 'same.pack')).toBe('stable pack');
    } finally {
      await root.removeEntry(stableName);
      await root.removeEntry(stableName + '-wal');
      await stablePacks.removeEntry('same.pack');
      await root.removeEntry('profile-packs');
      const experiment = await root.getDirectoryHandle(APP_STORAGE_PROFILE);
      await experiment.removeEntry('profile-packs');
    }
  });
});
