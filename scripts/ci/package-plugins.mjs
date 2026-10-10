import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve('.');
const require = createRequire(join(root, 'apps/readest-app/package.json'));
const { ZipWriter, Uint8ArrayWriter, Uint8ArrayReader } = require('@zip.js/zip.js');
const app = JSON.parse(readFileSync('apps/readest-app/package.json', 'utf8'));
const installedVersion = (name) => JSON.parse(readFileSync(join('apps/readest-app/node_modules', name, 'package.json'), 'utf8')).version;
const prefix = `Readest-Remote-V2_${app.version}`;
mkdirSync('release', { recursive: true });

async function writeZip(output, entries) {
  const zip = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false });
  for (const [name, bytes] of entries) await zip.add(name, new Uint8ArrayReader(bytes));
  writeFileSync(output, await zip.close());
}
function collect(directory, prefix = '', filter = () => true) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error('Do not package symlinks');
    if (!filter(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? collect(path, prefix + entry.name + '/', filter)
      : [[prefix + entry.name, readFileSync(path)]];
  });
}
const source = collect('.v2-artifacts/repository');
await writeZip(`release/${prefix}_plugin-source.zip`, source);
const sdk = readFileSync('.v2-artifacts/readest-plugin-sdk.tgz');
copyFileSync('.v2-artifacts/readest-plugin-sdk.tgz', `release/${prefix}_plugin-sdk.tgz`);
const examples = [
  ['readest-plugin-sdk.tgz', sdk],
  ['package.json', Buffer.from(JSON.stringify({
    name: 'readest-v2-plugin-examples', private: true, type: 'module',
    dependencies: { '@readest/plugin-sdk': 'file:./readest-plugin-sdk.tgz',
      esbuild: installedVersion('esbuild'),
      '@zip.js/zip.js': installedVersion('@zip.js/zip.js') },
  }, null, 2) + '\n')],
  ['README.md', Buffer.from('Install dependencies with `npm install`, then run `node scripts/build-plugins.mjs --key /path/to/private.pem --out repository`. Keep your Ed25519 private key outside this directory. Serve the output with `node scripts/serve-plugin-repository.mjs repository --port 4781`.\n')],
];
for (const name of ['build-plugins.mjs', 'serve-plugin-repository.mjs']) {
  examples.push(['scripts/' + name, readFileSync('scripts/' + name)]);
}
for (const name of ['kavita', 'komga']) {
  examples.push(...collect('plugins/' + name + '/src', 'plugins/' + name + '/src/'));
  for (const file of ['manifest.json', 'package.json']) {
    examples.push(['plugins/' + name + '/' + file, readFileSync('plugins/' + name + '/' + file)]);
  }
}
await writeZip(`release/${prefix}_plugin-examples.zip`, examples);
console.log(`Packaged signed repository, SDK and runnable examples for ${app.version}.`);
