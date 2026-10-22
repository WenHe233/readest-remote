import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pluginReleaseAssets, validatePluginReleaseIndex } from './plugin-release-lock.mjs';

const pin = { fingerprint: 'f'.repeat(64), assets: {
  'readest-plugin-source-0.1.1.zip': 'a'.repeat(64),
  'readest-plugin-sdk-0.1.0.tgz': 'b'.repeat(64),
  'readest-plugin-examples-0.1.1.zip': 'c'.repeat(64),
} };

test('legacy lock keeps the same signed source, SDK and examples assets', () => {
  assert.deepEqual(pluginReleaseAssets(pin), {
    'readest-plugin-source-0.1.1.zip': 'plugin-source.zip',
    'readest-plugin-sdk-0.1.0.tgz': 'plugin-sdk.tgz',
    'readest-plugin-examples-0.1.1.zip': 'plugin-examples.zip',
  });
  validatePluginReleaseIndex({ plugins: [
    { id: 'io.github.wenhe233.kavita', version: '0.1.1', fingerprint: pin.fingerprint },
    { id: 'io.github.wenhe233.komga', version: '0.1.1', fingerprint: pin.fingerprint },
  ] }, pin);
});

test('experimental release pins each plugin identity and channel independently', () => {
  const next = { ...pin, plugins: [{ id: 'example.adapter', version: '0.2.0-x1', channel: 'experimental' }], assets: {
    'readest-plugin-source-0.2.0-x1.zip': 'a'.repeat(64),
    'readest-plugin-sdk-0.2.0.tgz': 'b'.repeat(64),
    'readest-plugin-examples-0.2.0-x1.zip': 'c'.repeat(64),
  } };
  assert.equal(Object.keys(pluginReleaseAssets(next)).length, 3);
  const plugin = { ...next.plugins[0], fingerprint: pin.fingerprint };
  validatePluginReleaseIndex({ plugins: [plugin] }, next);
  for (const patch of [{ id: 'other' }, { version: '0.2.0' }, { fingerprint: 'bad' }, { channel: 'stable' }]) {
    assert.throws(() => validatePluginReleaseIndex({ plugins: [{ ...plugin, ...patch }] }, next), /identity mismatch/);
  }
  assert.throws(() => validatePluginReleaseIndex({ plugins: [plugin, plugin] }, next), /identity mismatch/);
  assert.throws(() => pluginReleaseAssets({ assets: { '../escape': 'a'.repeat(64) } }), /exactly one/);
  assert.throws(() => pluginReleaseAssets({ assets: { 'readest-plugin-sdk-0.2.0.tgz': 'bad' } }), /checksums/);
});
