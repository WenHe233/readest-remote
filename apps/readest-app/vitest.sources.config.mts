import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
import base from './vitest.browser.config.mts';
import { readSourceTestPackages } from './vitest.source-packages.mts';
const directory = resolve(process.env.READEST_SOURCE_PLUGIN_PACKAGES || '../../../readest-remote-plugins/dist/plugins');
const packages = readSourceTestPackages(directory);
const config = mergeConfig(base, {
  cacheDir: 'node_modules/.vite-sources',
  server: { headers: {} },
  define: { __SOURCE_TEST_PACKAGES__: JSON.stringify(packages) },
  test: { include: ['src/__tests__/services/plugins/source-sandbox.browser.test.ts'], fileParallelism: false, testTimeout: 60000, hookTimeout: 60000 },
});
config.server = { ...config.server, headers: {} };
config.test!.include = ['src/__tests__/services/plugins/source-sandbox.browser.test.ts'];
config.test!.exclude = [];
config.test!.browser!.instances = [{ browser: process.env.READEST_SOURCE_BROWSER === 'webkit' ? 'webkit' : 'chromium' }];
export default config;
