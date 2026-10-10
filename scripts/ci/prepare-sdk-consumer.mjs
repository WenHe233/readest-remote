import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2]);
const sdk = resolve('.v2-artifacts/readest-plugin-sdk.tgz').replaceAll('\\', '/');
mkdirSync(directory, { recursive: true });
cpSync('plugins/kavita/src', join(directory, 'src'), { recursive: true });
cpSync('plugins/kavita/manifest.json', join(directory, 'manifest.json'));
writeFileSync(join(directory, 'package.json'), JSON.stringify({
  name: 'readest-sdk-consumer-check', private: true, type: 'module',
  dependencies: { '@readest/plugin-sdk': `file:${sdk}` },
}, null, 2) + '\n');
