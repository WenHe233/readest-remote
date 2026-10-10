import { describe, expect, it } from 'vitest';
import {
  parseRepositoryImport,
  refreshRepository,
  downloadPluginRelease,
  mergePluginReleases,
  removePluginRepository,
} from '@/services/plugins/repositories';
import { installPlugin, uninstallPlugin, findInstalledPlugin } from '@/services/plugins/manager';
declare const __PLUGIN_TEST_SERVERS__: unknown;
describe.runIf(!!__PLUGIN_TEST_SERVERS__)('native static plugin repository', () => {
  it('imports a repository file, resolves relative package URLs, verifies signatures and installs', async () => {
    const url = parseRepositoryImport(JSON.stringify({ url: 'http://127.0.0.1:4781/repo.json' }));
    const repo = await refreshRepository(url);
    expect(repo.channel).toBe('stable');
    const releases = mergePluginReleases([repo]);
    expect(releases).toHaveLength(2);
    for (const release of releases) {
      expect(release.compatible).toBe(true);
      const pkg = await downloadPluginRelease(release);
      await uninstallPlugin(pkg.manifest.id);
      await installPlugin(pkg, true);
      expect(findInstalledPlugin(pkg.manifest.id)?.activeHash).toBe(release.sha256);
      await expect(downloadPluginRelease({ ...release, sha256: '0'.repeat(64) })).rejects.toThrow(
        /match/,
      );
    }
    await removePluginRepository(url);
  });
});
