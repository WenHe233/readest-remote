import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { preparePlugins } from './external-plugins.mjs';
if (!process.argv.includes('--test')) throw new Error('Production signing is owned by WenHe233/readest-remote-plugins');
const directory = await preparePlugins();
execFileSync(process.execPath, [join(directory, 'scripts/sign-plugins.mjs'), '--test', '--out', resolve('.v2-artifacts/ci-repository')], { stdio: 'inherit' });
