import { z } from 'zod';
import { rcompare, valid } from 'semver';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { readBoundedBody } from './httpBroker';
import { listPluginRecords, writePluginRecords } from './persistence';
import { MAX_PLUGIN_PACKAGE_BYTES, verifyPluginPackage } from './package';
import { supportsPluginApi } from './contract';
const repositorySchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(256),
  description: z.string().max(4096).optional(),
  index: z.string().max(2048),
});
const releaseSchema = z.strictObject({
  id: z.string().max(128),
  name: z.string().max(256),
  description: z.string().max(4096).optional(),
  version: z.string().refine((v) => !!valid(v)),
  channel: z.enum(['stable', 'beta', 'nightly']),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  downloadUrl: z.string().max(2048),
  size: z.number().int().positive().max(MAX_PLUGIN_PACKAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pluginApi: z.strictObject({ min: z.number().int().positive(), max: z.number().int().positive() }),
  contributions: z
    .array(
      z.enum([
        'librarySources',
        'dictionaryFormats',
        'contentSources',
        'sourceFormats',
        'managementPages',
        'settings',
      ]),
    )
    .max(4),
});
const indexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plugins: z.array(releaseSchema).max(10000),
});
export type PluginRelease = z.infer<typeof releaseSchema> & {
  repositoryUrl: string;
  compatible: boolean;
  conflict?: boolean;
};
export interface PluginRepository {
  url: string;
  id: string;
  name: string;
  enabled: boolean;
  channel: 'stable' | 'beta' | 'nightly';
  releases: PluginRelease[];
  updatedAt: number;
  error?: string;
}
function httpUrl(value: string, base?: string): string {
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP(S) repository URL');
  return url.href;
}
async function download(url: string, limit: number): Promise<Uint8Array> {
  const request = isTauriAppPlatform() ? nativeFetch : fetch;
  const response = await request(httpUrl(url), {
    credentials: 'omit',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Repository returned HTTP ${response.status}`);
  return readBoundedBody(response, limit);
}
export async function listPluginRepositories(): Promise<PluginRepository[]> {
  return (await listPluginRecords<PluginRepository>('repository:')).map((r) => r.value);
}
export async function refreshRepository(
  url: string,
  previous?: PluginRepository,
): Promise<PluginRepository> {
  url = httpUrl(url);
  const descriptor = repositorySchema.parse(
    JSON.parse(new TextDecoder().decode(await download(url, 128 * 1024))),
  );
  const indexUrl = httpUrl(descriptor.index, url);
  const index = indexSchema.parse(
    JSON.parse(new TextDecoder().decode(await download(indexUrl, 4 * 1024 * 1024))),
  );
  const releases = index.plugins.map((p) => ({
    ...p,
    downloadUrl: httpUrl(p.downloadUrl, indexUrl),
    repositoryUrl: url,
    compatible: supportsPluginApi(p.pluginApi),
  }));
  const repo: PluginRepository = {
    url,
    id: descriptor.id,
    name: descriptor.name,
    enabled: previous?.enabled ?? true,
    channel: previous?.channel ?? 'stable',
    releases,
    updatedAt: Date.now(),
  };
  await writePluginRecords({ ['repository:' + url]: repo });
  return repo;
}
export const savePluginRepository = (repo: PluginRepository): Promise<void> =>
  writePluginRecords({ ['repository:' + repo.url]: repo });
export const removePluginRepository = (url: string): Promise<void> =>
  writePluginRecords({}, ['repository:' + url]);
export function mergePluginReleases(repos: PluginRepository[]): PluginRelease[] {
  const merged = new Map<string, PluginRelease>();
  const signers = new Map<string, Set<string>>();
  for (const repo of repos.filter((r) => r.enabled))
    for (const release of repo.releases) {
      if (release.channel !== repo.channel) continue;
      const key = release.id + ':' + release.fingerprint;
      const current = merged.get(key);
      const keys = signers.get(release.id) ?? new Set();
      keys.add(release.fingerprint);
      signers.set(release.id, keys);
      if (
        !current ||
        (release.compatible && !current.compatible) ||
        (release.compatible === current.compatible &&
          rcompare(release.version, current.version) < 0)
      )
        merged.set(key, release);
    }
  return [...merged.values()]
    .map((r) => ({ ...r, conflict: (signers.get(r.id)?.size ?? 0) > 1 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
export async function downloadPluginRelease(release: PluginRelease) {
  const pkg = await verifyPluginPackage(
    await download(release.downloadUrl, MAX_PLUGIN_PACKAGE_BYTES),
  );
  if (
    pkg.bytes.length !== release.size ||
    pkg.packageHash !== release.sha256 ||
    pkg.fingerprint !== release.fingerprint ||
    pkg.manifest.id !== release.id ||
    pkg.manifest.pluginVersion !== release.version
  )
    throw new Error('Repository package does not match its release');
  return pkg;
}
export function parseRepositoryImport(text: string): string {
  const parsed = z
    .strictObject({ name: z.string().optional(), url: z.string() })
    .parse(JSON.parse(text));
  return httpUrl(parsed.url);
}
