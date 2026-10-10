import { isTauriAppPlatform } from '@/services/environment';
import { clearSecureItem, getSecureItem, setSecureItem } from '@/utils/bridge';
import { readPluginRecord, writePluginRecords } from './persistence';
const keyFor = (id: string) => 'readest.plugins.v2.connection.' + id;
async function webKey(): Promise<CryptoKey> {
  const existing = await readPluginRecord<CryptoKey>('vault:key');
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  await writePluginRecords({ 'vault:key': key });
  return key;
}
let vaultTail = Promise.resolve();
export async function getConnectionSecrets(id: string): Promise<Record<string, string>> {
  await vaultTail;
  if (isTauriAppPlatform()) {
    const result = await getSecureItem({ key: keyFor(id) });
    if (result.error) throw new Error('Unable to unlock plugin credentials');
    return result.value ? (JSON.parse(result.value) as Record<string, string>) : {};
  }
  const row = await readPluginRecord<{ iv: Uint8Array; data: ArrayBuffer }>('vault:' + id);
  if (!row) return {};
  const bytes = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(row.iv) },
    await webKey(),
    row.data,
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>;
}
export function setConnectionSecrets(id: string, secrets: Record<string, string>): Promise<void> {
  const operation = vaultTail.then(async () => {
    const value = JSON.stringify(secrets);
    if (isTauriAppPlatform()) {
      const result = await setSecureItem({ key: keyFor(id), value });
      if (!result.success) throw new Error('Unable to save plugin credentials');
    } else {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        await webKey(),
        new TextEncoder().encode(value),
      );
      await writePluginRecords({ ['vault:' + id]: { iv, data } });
    }
  });
  vaultTail = operation.catch(() => {});
  return operation;
}
export async function clearConnectionSecrets(id: string): Promise<void> {
  await vaultTail;
  if (isTauriAppPlatform()) {
    const result = await clearSecureItem({ key: keyFor(id) });
    if (!result.success) throw new Error('Unable to remove plugin credentials');
  } else await writePluginRecords({}, ['vault:' + id]);
}
