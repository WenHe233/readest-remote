import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageManagerCommand } from './external-plugins.mjs';

test('Unix package managers execute directly, including extensionless pnpm binaries', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(packageManagerCommand('pnpm', {
      platform,
      locate() { throw new Error('Unix binaries must not be resolved as Node scripts'); },
    }), ['pnpm']);
  }
});

test('Windows native package managers execute without Node', () => {
  assert.deepEqual(packageManagerCommand('pnpm', {
    platform: 'win32', locate: () => 'C:/Program Files/pnpm/pnpm.exe',
  }), ['C:/Program Files/pnpm/pnpm.exe']);
});

test('Windows JavaScript package manager shims use the current Node executable', () => {
  assert.deepEqual(packageManagerCommand('npm', {
    platform: 'win32', locate: () => 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js',
  }), [process.execPath, 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js']);
});
