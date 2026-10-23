import type { Json } from '@readest/plugin-sdk';
import {
  clearConnectionSecrets,
  getConnectionSecrets,
  setConnectionSecrets,
} from '../plugins/vault';
import { readPluginRecord, writePluginRecords } from '../plugins/persistence';

export interface EncryptedSourceValue {
  version: 1;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  size: number;
}
const keys = new Map<string, Promise<CryptoKey>>();
export function sourcePrivateScope(
  kind: 'kv' | 'cookie' | 'credentials',
  owner: { pluginId: string; fingerprint: string; id: string },
): string {
  return `source-${kind}:${owner.pluginId}:${owner.fingerprint}:${owner.id}:`;
}
export async function readSourceCredentials(owner: {
  pluginId: string;
  fingerprint: string;
  id: string;
}): Promise<Record<string, string>> {
  const scope = sourcePrivateScope('credentials', owner);
  const saved = await readSourcePrivateValue(scope, scope + 'value');
  if (saved !== null) {
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      Object.values(saved).some((value) => typeof value !== 'string')
    )
      throw new Error('Source credentials are invalid.');
    return saved as Record<string, string>;
  }
  // Migrate credentials written by earlier experimental builds; the native vault keeps only a short key afterwards.
  const legacy = await getConnectionSecrets(`source:${owner.id}`);
  if (Object.keys(legacy).length) {
    await writeSourceCredentials(owner, legacy);
    await clearConnectionSecrets(`source:${owner.id}`);
  }
  return legacy;
}
export async function writeSourceCredentials(
  owner: { pluginId: string; fingerprint: string; id: string },
  secrets: Record<string, string>,
): Promise<void> {
  if (new TextEncoder().encode(JSON.stringify(secrets)).byteLength > 2 * 1024 * 1024)
    throw new Error('Source credentials exceed the size limit.');
  const scope = sourcePrivateScope('credentials', owner);
  await writeSourcePrivateValue(scope, scope + 'value', secrets);
}
export async function forgetSourcePrivateKey(scope: string): Promise<void> {
  await keys.get(scope)?.catch(() => {});
  keys.delete(scope);
}
function storageKey(scope: string): Promise<CryptoKey> {
  let pending = keys.get(scope);
  if (!pending) {
    pending = (async () => {
      const saved = await getConnectionSecrets(`source-state-key:${scope}`);
      const raw = saved['key']
        ? Uint8Array.from(atob(saved['key']), (char) => char.charCodeAt(0))
        : crypto.getRandomValues(new Uint8Array(32));
      if (!saved['key'])
        await setConnectionSecrets(`source-state-key:${scope}`, {
          key: btoa(String.fromCharCode(...raw)),
        });
      return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    })().catch((error: unknown) => {
      keys.delete(scope);
      throw error;
    });
    keys.set(scope, pending);
  }
  return pending;
}
export async function readSourcePrivateValue(scope: string, key: string): Promise<Json | null> {
  const stored = await readPluginRecord<EncryptedSourceValue>(key);
  if (!stored) return null;
  if (stored.version !== 1) throw new Error('Unsupported source storage version.');
  const plain = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(stored.iv),
      additionalData: new TextEncoder().encode(key),
    },
    await storageKey(scope),
    stored.ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plain)) as Json;
}
export async function writeSourcePrivateValue(
  scope: string,
  key: string,
  value: Json,
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(key) },
    await storageKey(scope),
    bytes,
  );
  await writePluginRecords({
    [key]: { version: 1, iv, ciphertext, size: bytes.length } satisfies EncryptedSourceValue,
  });
}
