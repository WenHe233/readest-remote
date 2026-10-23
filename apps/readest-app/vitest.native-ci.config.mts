import config from './vitest.plugins.config.mts';
import { resolve } from 'node:path';
import { readSourceTestPackages } from './vitest.source-packages.mts';

config.define = { ...config.define, __SOURCE_TEST_PACKAGES__: JSON.stringify(readSourceTestPackages(resolve(
  process.env.READEST_SOURCE_PLUGIN_PACKAGES || '../../.v2-artifacts/ci-repository/plugins',
))) };

// Keep one WebDriver session: WebView2 cannot reliably navigate a new Vitest
// server after the previous session has closed. The test profile stays isolated.
config.test!.fileParallelism = false;
config.test!.include = [
  'src/**/*.tauri.test.ts',
  'src/__tests__/services/plugins/lifecycle.plugin.test.ts',
  'src/__tests__/services/plugins/cache.plugin.test.ts',
  'src/__tests__/services/plugins/isolation-native.plugin.test.ts',
  'src/__tests__/services/plugins/source-sandbox.browser.test.ts',
];
if (process.env['READEST_REAL_LIBRARY_ACCEPTANCE'] === '1') {
  config.test!.include.push(
    'src/__tests__/services/plugins/repository-native.plugin.test.ts',
    'src/__tests__/services/plugins/content.plugin.test.ts',
    'src/__tests__/services/plugins/search-native.plugin.test.ts',
  );
}

export default config;
