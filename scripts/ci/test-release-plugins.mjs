import { join, resolve } from 'node:path';
import { runPackageManager } from './external-plugins.mjs';

// package-plugins.mjs has already verified these immutable release asset hashes.
const root = resolve(import.meta.dirname, '../..');
const app = join(root, 'apps/readest-app');
process.env.READEST_SOURCE_PLUGIN_PACKAGES = join(root, '.v2-artifacts/repository/plugins');
runPackageManager('pnpm', ['exec', 'playwright', 'install', '--with-deps', 'chromium', 'webkit'], app);
for (const browser of ['chromium', 'webkit']) {
  process.env.READEST_SOURCE_BROWSER = browser;
  runPackageManager('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.sources.config.mts'], app);
}
