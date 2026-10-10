import { describe, expect, it } from 'vitest';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import { verifyPluginPackage, signingPayload, sha256 } from '@/services/plugins/package';
import {
  installPlugin,
  uninstallPlugin,
  setPluginEnabled,
  rollbackPlugin,
  findInstalledPlugin,
  setPluginPermission,
} from '@/services/plugins/manager';
import { writePluginRecords } from '@/services/plugins/persistence';
import { externalPluginDefinitions } from '@/services/plugins/externalCatalog';
import { createPluginRuntime } from '@/services/plugins/runtime';
import { createSandboxedPluginWorker } from '@/services/plugins/sandbox';
import { mergePluginReleases, type PluginRepository } from '@/services/plugins/repositories';
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
const bytes = (base64: string) => Uint8Array.from(atob(base64), (x) => x.charCodeAt(0));
const base64 = (data: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(data)));
const encoder = new TextEncoder();
const working = `onmessage=({data})=>{if(data.kind==='request')postMessage({kind:'response',protocolVersion:2,requestId:data.requestId,ok:true,result:{ready:true}})};`;
const id = 'test.lifecycle.' + crypto.randomUUID();
async function makePackage(
  keys: CryptoKeyPair,
  version: string,
  code = working,
  permissions = { network: true },
  pluginId = id,
) {
  const manifest = {
    id: pluginId,
    name: 'Lifecycle test',
    protocolVersion: 2,
    pluginVersion: version,
    entry: 'worker.js',
    pluginApi: { min: 2, max: 2 },
    permissions,
    contributions: {
      librarySources: [{ id: 'test', name: 'Test', formats: ['EPUB'], settings: [] }],
    },
  };
  const files = new Map([
    ['manifest.json', encoder.encode(JSON.stringify(manifest))],
    ['worker.js', encoder.encode(code)],
  ]);
  const list = await Promise.all(
    [...files].map(async ([path, data]) => ({
      path,
      size: data.length,
      sha256: await sha256(data),
    })),
  );
  const signature = {
    algorithm: 'Ed25519',
    publicKey: base64(await crypto.subtle.exportKey('raw', keys.publicKey)),
    files: list,
    signature: base64(await crypto.subtle.sign('Ed25519', keys.privateKey, signingPayload(list))),
  };
  files.set('signature.json', encoder.encode(JSON.stringify(signature)));
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [path, data] of files) await zip.add(path, new Uint8ArrayReader(data));
  return verifyPluginPackage(await zip.close());
}
describe('signed plugin lifecycle in the browser engine', () => {
  it('loads both real bundled reference workers through the opaque sandbox', async () => {
    for (const value of Object.values(__PLUGIN_TEST_PACKAGES__)) {
      const pkg = await verifyPluginPackage(bytes(value));
      const runtime = createPluginRuntime({
        createWorker: () => createSandboxedPluginWorker(pkg.workerSource),
      });
      try {
        await expect(
          runtime.call('ping', {}, { signal: AbortSignal.timeout(10000) }),
        ).resolves.toEqual({ ready: true });
      } finally {
        runtime.close();
      }
    }
  });
  it('requires permissions, stages updates, rejects signer changes, rolls back and revokes active calls', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const first = await makePackage(keys, '1.0.0');
    await expect(installPlugin(first, false)).rejects.toThrow(/permission/i);
    await installPlugin(first, true);
    expect(findInstalledPlugin(id)?.manifest.pluginVersion).toBe('1.0.0');
    const second = await makePackage(keys, '1.1.0');
    await expect(installPlugin(second, false)).rejects.toThrow(/permission/i);
    await installPlugin(second, true);
    expect(findInstalledPlugin(id)?.previousHash).toBe(first.packageHash);
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    await expect(installPlugin(await makePackage(other, '1.2.0'), true)).rejects.toThrow(/signer/i);
    await expect(
      installPlugin(await makePackage(keys, '1.2.0', 'throw new Error("startup failure");'), true),
    ).rejects.toThrow();
    expect(findInstalledPlugin(id)?.activeHash).toBe(second.packageHash);
    await rollbackPlugin(id);
    expect(findInstalledPlugin(id)?.activeHash).toBe(first.packageHash);
    const definition = externalPluginDefinitions().find((p) => p.manifest.id === id)!;
    const worker = definition.createWorker('lookup');
    await setPluginPermission(id, 'network', false);
    expect(findInstalledPlugin(id)?.permissions.network).toBe(false);
    expect(() => definition.createWorker('lookup')).toThrow(/revoked/i);
    await setPluginEnabled(id, false);
    expect(() => worker.postMessage('revoked')).toThrow();
    await setPluginEnabled(id, true);
    await uninstallPlugin(id);
    expect(findInstalledPlugin(id)).toBeUndefined();
    expect(externalPluginDefinitions().some((p) => p.manifest.id === id)).toBe(false);
    await expect(installPlugin(await makePackage(other, '2.0.0'), true)).rejects.toThrow(/signer/i);
    await installPlugin(first, true);
    await uninstallPlugin(id);
  });
  it('re-verifies persisted archives at restart and restores the last working version', async () => {
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const restartId = 'test.restart.' + crypto.randomUUID();
    const first = await makePackage(keys, '1.0.0', working, { network: true }, restartId);
    const second = await makePackage(keys, '1.1.0', working, { network: true }, restartId);
    await installPlugin(first, true);
    await installPlugin(second, true);
    await setPluginEnabled(restartId, false);
    await writePluginRecords({
      ['installed:' + restartId]: { ...findInstalledPlugin(restartId)!, enabled: true },
      ['archive:' + second.packageHash]: new Uint8Array([1, 2, 3]),
    });
    // Browser ESM keeps the original module even after vi.resetModules(). Load
    // a fresh module instance over the same persistent IndexedDB database.
    const url = new URL('../../../services/plugins/manager.ts', import.meta.url);
    url.searchParams.set('cold-start', crypto.randomUUID());
    const restarted = (await import(
      /* @vite-ignore */ url.href
    )) as typeof import('@/services/plugins/manager');
    await restarted.loadPluginManager();
    expect(restarted.findInstalledPlugin(restartId)?.activeHash).toBe(first.packageHash);
    expect(restarted.findInstalledPlugin(restartId)?.error).toMatch(/restored/i);
    await restarted.uninstallPlugin(restartId);
  });
  it('merges compatible releases per signer and flags identity conflicts', () => {
    const release = {
      id: 'source',
      name: 'Source',
      version: '1.0.0',
      channel: 'stable' as const,
      fingerprint: 'a'.repeat(64),
      downloadUrl: 'http://localhost/plugin',
      size: 100,
      sha256: 'b'.repeat(64),
      pluginApi: { min: 2, max: 2 },
      contributions: ['librarySources' as const],
      repositoryUrl: 'http://localhost/repo',
      compatible: true,
    };
    const repo: PluginRepository = {
      url: 'http://localhost/repo',
      id: 'test',
      name: 'Test',
      enabled: true,
      channel: 'stable',
      updatedAt: 1,
      releases: [
        release,
        { ...release, version: '2.0.0', compatible: false },
        { ...release, version: '1.1.0' },
        { ...release, version: '3.0.0', channel: 'beta' },
      ],
    };
    expect(mergePluginReleases([repo]).map((r) => r.version)).toEqual(['1.1.0']);
    repo.releases.push({ ...release, fingerprint: 'c'.repeat(64) });
    expect(mergePluginReleases([repo]).every((r) => r.conflict)).toBe(true);
  });
});
