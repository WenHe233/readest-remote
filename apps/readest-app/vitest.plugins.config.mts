import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { mergeConfig } from 'vitest/config';
const native = process.env.READEST_NATIVE_TEST === '1';
// CI exercises signed workers without requiring private library-server fixtures.
// Native acceptance keeps requiring those fixtures unless explicitly disabled.
const servers = native && process.env.READEST_PLUGIN_TEST_NO_SERVERS !== '1';
const cloudPhase = process.env.READEST_NATIVE_CLOUD_PHASE;
const cloudFixture = resolve('../../../.v2-local/native-cloud-fixture.json');
const {default: base} = await import(native ? './vitest.tauri.config.mts' : './vitest.browser.config.mts');
const repository = resolve(process.env.READEST_PLUGIN_TEST_REPOSITORY || '../../.v2-artifacts/repository');
const packages = Object.fromEntries(['kavita','komga'].map(name => {
  const manifest = JSON.parse(readFileSync(resolve('../../plugins', name, 'manifest.json'), 'utf8'));
  return [name, readFileSync(resolve(repository, 'plugins', name+'-'+manifest.pluginVersion+'.readest-plugin')).toString('base64')];
}));
const independentDirectory = resolve('../../.v2-artifacts/sdk-independent/plugins');
const independent = existsSync(independentDirectory)
  ? readdirSync(independentDirectory).filter(name => name.startsWith('sdk-consumer-') && name.endsWith('.readest-plugin')) : [];
if (independent.length > 1) throw new Error('Keep only one independent SDK test package');
if (independent[0]) packages['sdk-independent'] = readFileSync(resolve(independentDirectory, independent[0])).toString('base64');
const config = mergeConfig(base, {
  cacheDir: 'node_modules/.vite-external-plugins-' + (native ? 'native' : 'web'),
  define: {
    '__PLUGIN_TEST_WEB_PROGRESS__': JSON.stringify(process.env.READEST_WEB_PROGRESS_VERIFY === '1'),
    '__PLUGIN_TEST_ARTIFACTS__': JSON.stringify(resolve('../../.v2-artifacts/verification').replaceAll('\\', '/')),
    '__PLUGIN_TEST_CLOUD__': JSON.stringify(native && cloudPhase && existsSync(cloudFixture) ? {...JSON.parse(readFileSync(cloudFixture,'utf8')),phase:cloudPhase} : null),
    '__PLUGIN_TEST_PACKAGES__': JSON.stringify(packages),
    '__PLUGIN_TEST_BOOKS__': JSON.stringify(servers ? Object.fromEntries(['kavita','komga'].map(name=>[name,JSON.parse(readFileSync(resolve('../../.v2-artifacts/verification',name+'-catalog.json'),'utf8')).examples])) : {}),
    '__PLUGIN_TEST_SERVERS__': JSON.stringify(servers ? JSON.parse(readFileSync(resolve('../../../.v2-local/test-credentials.json'),'utf8')) : null),
  },
  test: {include: ['src/__tests__/services/plugins/*.plugin.test.ts'], testTimeout: 120000, hookTimeout: 120000},
});

config.test!.browser = {...config.test!.browser, ui:false, viewport:{width:1280,height:900}};
config.test!.include = ['src/__tests__/services/plugins/*.plugin.test.ts'];
export default config;
