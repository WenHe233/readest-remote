import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initializePlugin } from '../../packages/plugin-sdk/bin/plugin.mjs';
import { runPackageManager } from './external-plugins.mjs';

const root = resolve(import.meta.dirname, '../..');
const artifacts = join(root, '.v2-artifacts');
mkdirSync(artifacts, { recursive: true });
const temporary = mkdtempSync(join(artifacts, 'native-sdk-'));
const packages = {};
for (const kind of ['text', 'comic']) {
  const project = join(temporary, kind);
  await initializePlugin(project, kind, join(artifacts, 'readest-plugin-sdk.tgz'));
  runPackageManager('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], project);
  runPackageManager('npm', ['run', 'check'], project);
  runPackageManager('npm', ['run', 'build'], project);
  const files = readdirSync(join(project, 'dist')).filter((file) => file.endsWith('.readest-plugin'));
  if (files.length !== 1) throw new Error('Expected exactly one native template package');
  packages[kind] = join(project, 'dist', files[0]);
}
writeFileSync(join(artifacts, 'native-sdk-packages.json'), JSON.stringify(packages, null, 2));
