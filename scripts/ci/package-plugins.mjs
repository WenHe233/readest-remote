import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pluginReleaseAssets, validatePluginReleaseIndex } from './plugin-release-lock.mjs';

const root = resolve(import.meta.dirname, '../..');
const pin = JSON.parse(readFileSync(join(root, 'external-plugins.lock.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'apps/readest-app/package.json'), 'utf8')).version;
const require = createRequire(join(root, 'apps/readest-app/package.json'));
const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = require('@zip.js/zip.js');
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
const reader = new ZipReader(new Uint8ArrayReader(readFileSync(join(directory, sourceAsset))));
const repository = resolve('.v2-artifacts/repository');
try {
  for (const entry of await reader.getEntries()) {
    if (entry.directory || !/^(repo\.json|index\.json|local\.readest-repo|plugins\/[a-z0-9.-]+\.readest-plugin)$/.test(entry.filename)) throw new Error('Unexpected source archive entry');
    const path = join(repository, entry.filename);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, await entry.getData(new Uint8ArrayWriter()));
  }
} finally { await reader.close(); }
const index = JSON.parse(readFileSync(join(repository, 'index.json')));
validatePluginReleaseIndex(index, pin);
console.log('Packaged the pinned independent plugin release');
