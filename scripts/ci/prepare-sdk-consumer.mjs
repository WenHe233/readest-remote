import { preparePlugins } from './external-plugins.mjs';
const external = await preparePlugins();
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2]);
const sdk = resolve('.v2-artifacts/readest-plugin-sdk.tgz').replaceAll('\\', '/');
mkdirSync(directory, { recursive: true });
cpSync(join(external, 'plugins/kavita/src'), join(directory, 'src'), { recursive: true });
cpSync(join(external, 'plugins/kavita/manifest.json'), join(directory, 'manifest.json'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'readest-sdk-consumer-check', private: true, type: 'module',
  dependencies: { '@readest/plugin-sdk': `file:${sdk}` },
  pnpm: { overrides: { zod: JSON.parse(readFileSync('apps/readest-app/node_modules/zod/package.json', 'utf8')).version } },
}, null, 2) + '\n');
