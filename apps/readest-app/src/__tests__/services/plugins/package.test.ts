import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { verifyPluginPackage, signingPayload } from '@/services/plugins/package';

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});
const encoder = new TextEncoder();
const manifest = {
  id: 'test.library',
  protocolVersion: 2,
  pluginVersion: '1.0.0',
  name: 'Test library',
  entry: 'worker.js',
  pluginApi: { min: 2, max: 2 },
  permissions: { network: true },
  contributions: {
    librarySources: [{ id: 'test', name: 'Test', formats: ['EPUB'], settings: [] }],
  },
};
async function archive(tamper = false, extraPath?: string, changes = {}) {
  const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const files = new Map([
    ['manifest.json', encoder.encode(JSON.stringify({ ...manifest, ...changes }))],
    ['worker.js', encoder.encode('postMessage(1);')],
  ]);
  const list = [];
  for (const [path, data] of files)
    list.push({
      path,
      size: data.byteLength,
      sha256: Buffer.from(await crypto.subtle.digest('SHA-256', data)).toString('hex'),
    });
  list.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const signature = {
    algorithm: 'Ed25519',
    publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64'),
    files: list,
    signature: Buffer.from(
      await crypto.subtle.sign('Ed25519', keys.privateKey, signingPayload(list)),
    ).toString('base64'),
  };
  if (tamper) files.set('worker.js', encoder.encode('postMessage(2);'));
  if (extraPath) files.set(extraPath, encoder.encode('extra'));
  files.set('signature.json', encoder.encode(JSON.stringify(signature)));
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [path, data] of files) await zip.add(path, new Uint8ArrayReader(data));
  return zip.close();
}
describe('signed external plugin package', () => {
  it('verifies a signed package and returns its signer and code', async () => {
    const installed = await verifyPluginPackage(await archive());
    expect(installed.manifest.id).toBe('test.library');
    expect(installed.workerSource).toBe('postMessage(1);');
    expect(installed.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects changed code', async () => {
    await expect(archive(true).then(verifyPluginPackage)).rejects.toThrow(/digest/i);
  });
  it('rejects unsigned additional files', async () => {
    await expect(archive(false, 'extra.js').then(verifyPluginPackage)).rejects.toThrow(
      /unsigned|inventory/i,
    );
  });
  it('rejects traversal paths', async () => {
    await expect(archive(false, '../outside').then(verifyPluginPackage)).rejects.toThrow(/path/i);
  });
  it('rejects an incompatible API and reserved upstream plugin identity', async () => {
    await expect(
      archive(false, undefined, { pluginApi: { min: 3, max: 3 } }).then(verifyPluginPackage),
    ).rejects.toThrow(/compatib/i);
    await expect(
      archive(false, undefined, { id: 'readest.yomitan' }).then(verifyPluginPackage),
    ).rejects.toThrow(/reserved/i);
  });
  it('rejects case aliases and Windows device paths', async () => {
    for (const path of ['WORKER.js', 'resources/CON.txt'])
      await expect(archive(false, path).then(verifyPluginPackage)).rejects.toThrow(
        /inventory|path/i,
      );
  });
});
