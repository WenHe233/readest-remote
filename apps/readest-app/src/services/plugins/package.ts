import { ZipReader, Uint8ArrayReader } from '@zip.js/zip.js';
import { z } from 'zod';
import { valid as validVersion } from 'semver';
import { PLUGIN_PROTOCOL_VERSION, pluginManifestSchema, type PluginManifest } from './contract';

export const MAX_PLUGIN_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_PLUGIN_UNPACKED_BYTES = 32 * 1024 * 1024;
const fileSchema = z.strictObject({
  path: z.string().min(1).max(256),
  size: z.number().int().nonnegative().max(MAX_PLUGIN_UNPACKED_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const signatureSchema = z.strictObject({
  algorithm: z.literal('Ed25519'),
  publicKey: z.string().max(128),
  signature: z.string().max(256),
  files: z.array(fileSchema).min(2).max(256),
});
export type SignedFile = z.infer<typeof fileSchema>;
export interface VerifiedPluginPackage {
  manifest: PluginManifest;
  publicKey: string;
  fingerprint: string;
  packageHash: string;
  workerSource: string;
  bytes: Uint8Array;
  resources: Record<string, string>;
}
export const signingPayload = (files: SignedFile[]): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(
    JSON.stringify({
      format: 1,
      files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    }),
  );
export const sha256 = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export const toBase64 = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''));
export function validatePackagePath(path: string): void {
  if (
    !/^[a-zA-Z0-9_.\-/]+$/u.test(path) ||
    path.startsWith('/') ||
    path
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/iu.test(part) ||
          part.endsWith('.'),
      )
  )
    throw new Error('Invalid plugin package path');
}
export async function verifyPluginPackage(bytes: Uint8Array): Promise<VerifiedPluginPackage> {
  if (!bytes.byteLength || bytes.byteLength > MAX_PLUGIN_PACKAGE_BYTES)
    throw new Error('Plugin package exceeds size limit');
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false });
  const files = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let total = 0;
  try {
    const entries = await reader.getEntries();
    if (entries.length > 257) throw new Error('Plugin package has too many files');
    for (const entry of entries) {
      validatePackagePath(entry.filename);
      const name = entry.filename.toLowerCase();
      if (
        names.has(name) ||
        entry.directory ||
        entry.encrypted ||
        entry.uncompressedSize > MAX_PLUGIN_UNPACKED_BYTES
      )
        throw new Error('Invalid plugin file inventory');
      names.add(name);
      const chunks: Uint8Array[] = [];
      let size = 0;
      await entry.getData(
        new WritableStream<Uint8Array>({
          write(chunk) {
            size += chunk.length;
            total += chunk.length;
            if (total > MAX_PLUGIN_UNPACKED_BYTES || size > entry.uncompressedSize)
              throw new Error('Plugin package exceeds unpacked size limit');
            chunks.push(chunk.slice());
          },
        }),
        { useWebWorkers: false, checkSignature: true },
      );
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      files.set(entry.filename, data);
    }
  } finally {
    await reader.close();
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const signatureBytes = files.get('signature.json');
  if (!signatureBytes || signatureBytes.length > 128 * 1024)
    throw new Error('Plugin signature is missing');
  const signature = signatureSchema.parse(JSON.parse(decoder.decode(signatureBytes)));
  if (signature.files.length !== files.size - 1)
    throw new Error('Unsigned files in plugin inventory');
  const signedNames = new Set<string>();
  for (const file of signature.files) {
    validatePackagePath(file.path);
    if (file.path === 'signature.json' || signedNames.has(file.path))
      throw new Error('Invalid signed inventory');
    signedNames.add(file.path);
    const data = files.get(file.path);
    if (!data || data.length !== file.size || (await sha256(data)) !== file.sha256)
      throw new Error('Plugin file digest does not match signature');
  }
  const publicBytes = fromBase64(signature.publicKey);
  const signatureData = fromBase64(signature.signature);
  if (publicBytes.length !== 32 || signatureData.length !== 64)
    throw new Error('Invalid Ed25519 signature');
  const key = await crypto.subtle.importKey('raw', publicBytes, 'Ed25519', false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', key, signatureData, signingPayload(signature.files))))
    throw new Error('Plugin signature verification failed');
  if (!files.has('manifest.json') || !files.has('worker.js'))
    throw new Error('Plugin manifest or worker is missing');
  const manifest = pluginManifestSchema.parse(
    JSON.parse(decoder.decode(files.get('manifest.json'))),
  );
  if (
    !manifest.name ||
    manifest.entry !== 'worker.js' ||
    !manifest.pluginApi ||
    !validVersion(manifest.pluginVersion)
  )
    throw new Error('Invalid external plugin manifest');
  if (
    manifest.pluginApi.min > PLUGIN_PROTOCOL_VERSION ||
    manifest.pluginApi.max < PLUGIN_PROTOCOL_VERSION
  )
    throw new Error('Plugin API is incompatible with this application');
  if (
    !manifest.contributions.dictionaryFormats.length &&
    !manifest.contributions.librarySources?.length
  )
    throw new Error('Plugin has no supported contributions');
  if (manifest.id.startsWith('readest.')) throw new Error('Bundled plugin identity is reserved');
  return {
    resources: Object.fromEntries(
      [...files]
        .filter(([path]) => !['manifest.json', 'signature.json', manifest.entry].includes(path))
        .map(([path, data]) => [path, toBase64(data)]),
    ),
    manifest,
    publicKey: signature.publicKey,
    fingerprint: await sha256(publicBytes),
    packageHash: await sha256(bytes),
    workerSource: decoder.decode(files.get('worker.js')),
    bytes: bytes.slice(),
  };
}
