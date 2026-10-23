import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateExperimentalPluginLock } from './experimental-plugins.mjs';

const pin = { revision: 'a'.repeat(40), release: 'v0.2.0-x1', fingerprint: 'b'.repeat(64),
  plugins: ['legado', 'venera'].map((name) => ({ id: `io.github.wenhe233.${name}`, version: '0.2.0-x1' })),
  assets: { 'readest-plugin-source-0.2.0-x1.zip': 'c'.repeat(64), 'readest-plugin-sdk-0.2.0.tgz': 'd'.repeat(64), 'readest-plugin-examples-0.2.0-x1.zip': 'e'.repeat(64) },
};
test('experimental CI refuses the legacy plugin pin and requires both engine identities', () => {
  assert.throws(() => validateExperimentalPluginLock({ ...pin, plugins: undefined }), /not release-pinned/);
  assert.throws(() => validateExperimentalPluginLock({ ...pin, plugins: pin.plugins.slice(0, 1) }), /not release-pinned/);
  assert.throws(() => validateExperimentalPluginLock({ ...pin, revision: 'branch-name' }), /not release-pinned/);
  validateExperimentalPluginLock(pin);
});
test('channel checks propagate the frozen SHA and use signed packages for both engines', () => {
  const checks = readFileSync('.github/workflows/pull-request.yml', 'utf8');
  assert.match(checks, /CHANNEL_SOURCE_SHA: \$\{\{ inputs.source_sha \|\| github.sha \}\}/);
  assert.match(checks, /node scripts\/ci\/test-channel.mjs/);
  const script = readFileSync('scripts/ci/test-channel.mjs', 'utf8');
  assert.match(script, /'--test', 'packages\/plugin-sdk\/tests\/\*\.test.mjs'/);
  assert.match(script, /\['chromium', 'webkit'\]/);
  assert.match(script, /\.v2-artifacts\/ci-repository\/plugins/);
});

test('release and native verification include the signed compatibility engines', () => {
  const workflow = readFileSync('.github/workflows/release-build.yml', 'utf8');
  assert.match(workflow, /node scripts\/ci\/test-release-plugins.mjs/);
  assert.match(workflow, /if: \$\{\{ !inputs.experimental \}\}/);
  const native = readFileSync('apps/readest-app/vitest.native-ci.config.mts', 'utf8');
  assert.match(native, /__SOURCE_TEST_PACKAGES__/);
  assert.match(native, /source-sandbox\.browser\.test\.ts/);
});
