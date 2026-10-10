import { listPluginRecords, readPluginRecord, writePluginRecords } from './persistence';
import { sha256 } from './package';
export const PLUGIN_CACHE_BUDGET = 1024 * 1024 * 1024;
export const PLUGIN_RANGE_CHUNK = 128 * 1024;
interface CacheEntry {
  size: number;
  used: number;
  mime: string;
}
let writes: Promise<unknown> = Promise.resolve();
export async function cacheKey(
  bookHash: string,
  revision: string,
  resource: string,
): Promise<string> {
  return bookHash + ':' + (await sha256(new TextEncoder().encode(revision + ':' + resource)));
}
export async function readContentCache(
  key: string,
): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
  const meta = await readPluginRecord<CacheEntry>('cache-meta:' + key);
  if (!meta) return;
  const bytes = await readPluginRecord<Uint8Array>('cache-data:' + key);
  if (!bytes) return;
  void writePluginRecords({ ['cache-meta:' + key]: { ...meta, used: Date.now() } }).catch(() => {});
  return { bytes, mime: meta.mime };
}
export async function writeContentCache(
  key: string,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  const operation = writes.then(async () => {
    const entries = await listPluginRecords<CacheEntry>('cache-meta:');
    let total =
      entries.filter((e) => e.key !== 'cache-meta:' + key).reduce((n, e) => n + e.value.size, 0) +
      bytes.length;
    const remove: string[] = [];
    for (const entry of entries.sort((a, b) => a.value.used - b.value.used)) {
      if (total <= PLUGIN_CACHE_BUDGET) break;
      if (entry.key === 'cache-meta:' + key) continue;
      remove.push(entry.key, entry.key.replace('cache-meta:', 'cache-data:'));
      total -= entry.value.size;
    }
    await writePluginRecords(
      {
        ['cache-meta:' + key]: { size: bytes.length, used: Date.now(), mime },
        ['cache-data:' + key]: bytes,
      },
      remove,
    );
  });
  writes = operation.catch(() => {});
  // Running out of cache space must not stop an otherwise successful read.
  await operation.catch(() => {});
}
export async function getContentCacheBytes(): Promise<number> {
  return (await listPluginRecords<CacheEntry>('cache-meta:')).reduce((n, e) => n + e.value.size, 0);
}
export async function clearContentCache(bookHash = ''): Promise<void> {
  await writes;
  const entries = await listPluginRecords<CacheEntry>('cache-meta:' + bookHash);
  await writePluginRecords(
    {},
    entries.flatMap((e) => [e.key, e.key.replace('cache-meta:', 'cache-data:')]),
  );
}
