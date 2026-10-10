import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { preparePlugins } from './ci/external-plugins.mjs';
const directory = await preparePlugins();
execFileSync(process.execPath, [join(directory, 'scripts/build-plugins.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' });
