import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = 'apps/readest-app/';
const read = (file) => readFileSync(`${app}${file}`, 'utf8');
const id = 'io.github.wenhe233.readestremote.experimental';

test('experimental installation has its own identity, schemes and internal build number', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.equal(config.identifier, id);
  assert.equal(config.productName, 'Readest Remote Experimental');
  assert.equal(config.mainBinaryName, 'readest-remote-x');
  assert.match(JSON.parse(read('package.json')).version, /^\d+\.\d+\.\d+-x[1-9]\d*$/);
  assert.deepEqual(config.plugins['deep-link'].desktop.schemes, ['readest-remote-x', 'readest-remote-x-onedrive']);
  assert.equal(config.bundle.windows.nsis.installerHooks, undefined);
  assert.ok(Number(config.bundle.iOS.bundleVersion) > 12012002);
  assert.equal(config.bundle.iOS.bundleVersion, config.bundle.macOS.bundleVersion);
  assert.ok(read('src-tauri/gen/android/app/build.gradle.kts').includes(`applicationId = "${id}"`));
  assert.ok(read('src-tauri/gen/apple/project.yml').includes(`PRODUCT_BUNDLE_IDENTIFIER: ${id}.ShareExtension`));
});

test('native source HTTP is granted only to local reader host windows', () => {
  const config = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.ok(config.app.security.capabilities.includes('source-http'));
  const capability = JSON.parse(read('src-tauri/capabilities/source-http.json'));
  assert.equal(capability.local, true);
  assert.equal(capability.remote, undefined);
  assert.deepEqual(capability.windows, ['main', 'reader-*']);
  assert.deepEqual(capability.permissions, ['allow-source-http-request', 'allow-source-http-cancel']);
  assert.doesNotMatch(read('src-tauri/capabilities/webdriver-remote.json'), /allow-source-http/);
  assert.doesNotMatch(read('src-tauri/capabilities/default.json'), /allow-source-http/);
});

test('experimental startup cannot migrate stable profiles or register stable Explorer handlers', () => {
  assert.doesNotMatch(read('src-tauri/src/lib.rs'), /builder\.plugin\(legacy_profile::init\(\)\)/);
  assert.match(read('src-tauri/src/experimental_profile.rs'), /Readest-Remote-Experimental/);
  assert.match(read('src/services/nativeAppService.ts'), /Readest-Remote-Experimental/);
  assert.doesNotMatch(read('src-tauri/plugins/tauri-plugin-native-bridge/src/desktop.rs'), /None => "io\.github\.wenhe233\.readestremote"/);
});
