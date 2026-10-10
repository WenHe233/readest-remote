// One IndexedDB transaction switches active package pointers and keeps the
// previous immutable archive. Native WebViews persist this in the V2 profile.
let opening: Promise<IDBDatabase> | undefined;
function database(): Promise<IDBDatabase> {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('readest-external-plugins-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        opening = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      opening = undefined;
      reject(request.error);
    };
  }));
}
export async function readPluginRecord<T>(key: string): Promise<T | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const req = db.transaction('records').objectStore('records').get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}
export async function writePluginRecords(
  records: Record<string, unknown>,
  remove: string[] = [],
): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    for (const [key, value] of Object.entries(records)) store.put(value, key);
    for (const key of remove) store.delete(key);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });
}
export async function listPluginRecords<T>(
  prefix: string,
): Promise<Array<{ key: string; value: T }>> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const items: Array<{ key: string; value: T }> = [];
    const req = db
      .transaction('records')
      .objectStore('records')
      .openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push({ key: String(cursor.key), value: cursor.value as T });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
