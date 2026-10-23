import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import base from './vitest.browser.config.mts';

const files = JSON.parse(readFileSync(resolve('../../.v2-artifacts/native-sdk-packages.json'), 'utf8')) as Record<string, string>;
base.define = { ...base.define, __NATIVE_TEST_PACKAGES__: JSON.stringify(Object.fromEntries(
  Object.entries(files).map(([kind, path]) => [kind, readFileSync(path).toString('base64')]),
)) };
base.cacheDir = 'node_modules/.vite-native-providers';
base.test!.include = ['src/__tests__/services/plugins/native-provider.plugin.test.ts'];
base.test!.exclude = [];
base.test!.fileParallelism = false;
base.test!.testTimeout = 60000;
export default base;
