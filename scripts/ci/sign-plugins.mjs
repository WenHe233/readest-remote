import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { preparePlugins } from './external-plugins.mjs';
if (!process.argv.includes('--test')) throw new Error('Production signing is owned by WenHe233/readest-remote-plugins');
const directory = await preparePlugins();
const version = JSON.parse(readFileSync('apps/readest-app/package.json', 'utf8')).version;
const all = process.argv.includes('--test-all') || /^\d+\.\d+\.\d+-x[1-9]\d*$/.test(version);
execFileSync(process.execPath, [join(directory, 'scripts/sign-plugins.mjs'), '--test', ...(all ? ['--test-all'] : []), '--out', resolve('.v2-artifacts/ci-repository')], { stdio: 'inherit' });
