import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pluginReleaseAssets, validatePluginReleaseIndex } from './plugin-release-lock.mjs';
import { extractPluginRepository } from './extract-plugin-repository.mjs';

const root = resolve(import.meta.dirname, '../..');
const pin = JSON.parse(readFileSync(join(root, 'external-plugins.lock.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'apps/readest-app/package.json'), 'utf8')).version;
const directory = resolve('.v2-artifacts/plugin-release');
mkdirSync(directory, { recursive: true });
mkdirSync('release', { recursive: true });
const mappings = pluginReleaseAssets(pin);
for (const [name, output] of Object.entries(mappings)) {
  if (process.env.READEST_PLUGIN_RELEASE_DIRECTORY) copyFileSync(join(process.env.READEST_PLUGIN_RELEASE_DIRECTORY, name), join(directory, name));
  else execFileSync('gh', ['release', 'download', pin.release, '--repo', pin.repository, '--pattern', name, '--dir', directory, '--clobber'], { stdio: 'inherit' });
  const bytes = readFileSync(join(directory, name));
  if (createHash('sha256').update(bytes).digest('hex') !== pin.assets[name]) throw new Error(`Unexpected plugin release bytes: ${name}`);
  copyFileSync(join(directory, name), `release/Readest-Remote_${version}_${output}`);
}
const sourceAsset = Object.keys(mappings).find((name) => mappings[name] === 'plugin-source.zip');
await extractPluginRepository(readFileSync(join(directory, sourceAsset)), root, (staging) => {
  const index = JSON.parse(readFileSync(join(staging, 'index.json')));
  validatePluginReleaseIndex(index, pin);
});
console.log('Packaged the pinned independent plugin release');
