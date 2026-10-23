import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPackageManager } from './external-plugins.mjs';
import { validateExperimentalPluginLock } from './experimental-plugins.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (name) => JSON.parse(readFileSync(join(root, name), 'utf8'));
const expected = process.env.CHANNEL_SOURCE_SHA;
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(expected || '') || expected !== actual) throw new Error('Channel checks must use the frozen release commit');
if (!/^\d+\.\d+\.\d+-x[1-9]\d*$/.test(read('apps/readest-app/package.json').version)) throw new Error('This channel test entry is for experimental versions');
validateExperimentalPluginLock(read('external-plugins.lock.json'));

// Native examples use development signatures; production signing belongs to the plugin repository.
execFileSync(process.execPath, ['--test', 'packages/plugin-sdk/tests/*.test.mjs'], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/ci/build-native-plugin-examples.mjs'], { cwd: root, stdio: 'inherit' });
runPackageManager('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.native-providers.config.mts'], join(root, 'apps/readest-app'));
process.env.READEST_SOURCE_PLUGIN_PACKAGES = join(root, '.v2-artifacts/ci-repository/plugins');
for (const browser of ['chromium', 'webkit']) {
  process.env.READEST_SOURCE_BROWSER = browser;
  runPackageManager('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.sources.config.mts'], join(root, 'apps/readest-app'));
}
