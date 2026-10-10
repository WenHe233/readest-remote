import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
const native = process.env.READEST_NATIVE_TEST === '1';
const cloudPhase = process.env.READEST_NATIVE_CLOUD_PHASE;
const cloudFixture = resolve('../../../.v2-local/native-cloud-fixture.json');
const {default: base} = await import(native ? './vitest.tauri.config.mts' : './vitest.browser.config.mts');
const packages = Object.fromEntries(['kavita','komga'].map(name => [name,
  readFileSync(resolve('../../.v2-artifacts/repository/plugins',name+'-0.1.0.readest-plugin')).toString('base64')]));
const independent = resolve('../../.v2-artifacts/sdk-independent/plugins/sdk-consumer-0.1.0.readest-plugin');
if (existsSync(independent)) packages['sdk-independent'] = readFileSync(independent).toString('base64');
const config = mergeConfig(base, {
  cacheDir: 'node_modules/.vite-external-plugins-' + (native ? 'native' : 'web'),
  define: {
    '__PLUGIN_TEST_WEB_PROGRESS__': JSON.stringify(process.env.READEST_WEB_PROGRESS_VERIFY === '1'),
    '__PLUGIN_TEST_ARTIFACTS__': JSON.stringify(resolve('../../.v2-artifacts/verification').replaceAll('\\', '/')),
    '__PLUGIN_TEST_CLOUD__': JSON.stringify(native && cloudPhase && existsSync(cloudFixture) ? {...JSON.parse(readFileSync(cloudFixture,'utf8')),phase:cloudPhase} : null),
    '__PLUGIN_TEST_PACKAGES__': JSON.stringify(packages),
    '__PLUGIN_TEST_BOOKS__': JSON.stringify(Object.fromEntries(['kavita','komga'].map(name=>[name,JSON.parse(readFileSync(resolve('../../.v2-artifacts/verification',name+'-catalog.json'),'utf8')).examples]))),
    '__PLUGIN_TEST_SERVERS__': JSON.stringify(native ? JSON.parse(readFileSync(resolve('../../../.v2-local/test-credentials.json'),'utf8')) : null),
  },
  test: {include: ['src/__tests__/services/plugins/*.plugin.test.ts'], testTimeout: 120000, hookTimeout: 120000},
});

config.test!.browser = {...config.test!.browser, ui:false, viewport:{width:1280,height:900}};
config.test!.include = ['src/__tests__/services/plugins/*.plugin.test.ts'];
export default config;
