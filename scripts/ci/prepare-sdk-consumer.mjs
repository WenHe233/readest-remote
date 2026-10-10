import { preparePlugins } from './external-plugins.mjs';
const external = await preparePlugins();
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2]);
const sdk = resolve('.v2-artifacts/readest-plugin-sdk.tgz').replaceAll('\\', '/');
const zod = JSON.parse(readFileSync('apps/readest-app/node_modules/zod/package.json', 'utf8')).version;
mkdirSync(directory, { recursive: true });
cpSync(join(external, 'plugins/kavita/src'), join(directory, 'src'), { recursive: true });
cpSync(join(external, 'plugins/kavita/manifest.json'), join(directory, 'manifest.json'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'readest-sdk-consumer-check', private: true, type: 'module', packageManager: 'pnpm@11.1.1',
  dependencies: { '@readest/plugin-sdk': `file:${sdk}` },
}, null, 2) + '\n');
// pnpm 11 reads overrides from the workspace file. An exact version still needs
// registry metadata on a clean runner; the installation step may fetch it.
writeFileSync(join(directory, 'pnpm-workspace.yaml'), `overrides:\n  zod: '${zod}'\n`);
