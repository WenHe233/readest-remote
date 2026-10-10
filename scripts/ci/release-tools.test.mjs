import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { expectedAssets, verifyReleaseAssets } from '../verify-release-assets.mjs';

test('complete V2 matrix excludes V1 packages, missing architectures, updater files and private files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readest-v2-assets-'));
  try {
    const names = expectedAssets('0.12.12');
    for (const name of names) writeFileSync(join(dir, name), 'artifact');
    assert.equal(verifyReleaseAssets(dir, '0.12.12').length, 19);
    unlinkSync(join(dir, names[0]));
    assert.throws(() => verifyReleaseAssets(dir, '0.12.12'), /missing .*windows-x64/);
    writeFileSync(join(dir, names[0]), '');
    assert.throws(() => verifyReleaseAssets(dir, '0.12.12'), /empty or non-regular/);
    writeFileSync(join(dir, names[0]), 'artifact');
    for (const extra of ['latest.json', 'private.pem', 'Readest-Remote_0.12.12_windows-x64-setup.exe']) {
      writeFileSync(join(dir, extra), 'unexpected');
      assert.throws(() => verifyReleaseAssets(dir, '0.12.12'), /unexpected/);
      unlinkSync(join(dir, extra));
    }
    assert.throws(() => expectedAssets('../escape'), /Invalid release version/);
  } finally {
    for (const name of readdirSync(dir)) unlinkSync(join(dir, name));
    rmdirSync(dir);
  }
});

test('build configuration requires a deployment and refuses service-role credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readest-v2-env-'));
  mkdirSync(join(dir, 'apps/readest-app'), { recursive: true });
  const script = resolve('scripts/ci/configure-build.mjs');
  const env = { ...process.env, NEXT_PUBLIC_API_BASE_URL: 'http://127.0.0.1:3003',
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:18000', NEXT_PUBLIC_SUPABASE_ANON_KEY: '' };
  const run = () => spawnSync(process.execPath, [script], { cwd: dir, env, encoding: 'utf8' });
  try {
    assert.notEqual(run().status, 0);
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sb_secret_do-not-ship';
    assert.match(run().stderr, /server-only/);
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = `header.${Buffer.from('{"role":"service_role"}').toString('base64url')}.signature`;
    assert.match(run().stderr, /server-only/);
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'public-anon-key';
    assert.equal(run().status, 0);
    const output = readFileSync(join(dir, 'apps/readest-app/.env.local'), 'utf8');
    assert.match(output, /NEXT_PUBLIC_SELF_HOSTED="true"/);
    assert.doesNotMatch(output, /service_role|sb_secret_/);
    env.NEXT_PUBLIC_API_BASE_URL = 'https://user:password@example.com';
    assert.notEqual(run().status, 0);
  } finally {
    for (const name of readdirSync(join(dir, 'apps/readest-app'))) unlinkSync(join(dir, 'apps/readest-app', name));
    rmdirSync(join(dir, 'apps/readest-app'));
    rmdirSync(join(dir, 'apps'));
    rmdirSync(dir);
  }
});

test('release signing cannot silently generate a key or change the configured signer', () => {
  const script = resolve('scripts/ci/sign-plugins.mjs');
  const env = { ...process.env, READEST_PLUGIN_SIGNING_KEY_PEM: '', READEST_PLUGIN_SIGNER_SHA256: '0'.repeat(64) };
  const run = () => spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  assert.match(run().stderr, /Configure READEST_PLUGIN_SIGNING_KEY_PEM/);
  env.READEST_PLUGIN_SIGNING_KEY_PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.match(run().stderr, /does not match/);
  env.READEST_PLUGIN_SIGNING_KEY_PEM = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  assert.match(run().stderr, /requires an Ed25519 key/);
});
