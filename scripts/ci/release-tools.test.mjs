import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, readdirSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
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
    for (const extra of ['latest.json', 'private.pem', 'Readest-Remote-V2_0.12.12_windows-x64-setup.exe']) {
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
  const run = () => spawnSync(process.execPath, [script, '--cloud'], { cwd: dir, env, encoding: 'utf8' });
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

test('the host cannot sign production plugins', () => {
  const script = resolve('scripts/ci/sign-plugins.mjs');
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Production signing is owned by WenHe233/);
});

test('the release defaults to disabled cloud without any deployment variables', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readest-cloud-off-'));
  mkdirSync(join(dir, 'apps/readest-app'), { recursive: true });
  try {
    const result = spawnSync(process.execPath, [resolve('scripts/ci/configure-build.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const content = readFileSync(join(dir, 'apps/readest-app/.env.local'), 'utf8');
    assert.match(content, /NEXT_PUBLIC_READEST_CLOUD_ENABLED="false"/);
    assert.match(content, /NEXT_PUBLIC_SELF_HOSTED="true"/);
    assert.match(content, /NEXT_PUBLIC_API_BASE_URL=""/);
    assert.match(content, /NEXT_PUBLIC_SUPABASE_URL=""/);
    assert.match(content, /NEXT_PUBLIC_SUPABASE_ANON_KEY=""/);
    assert.equal(existsSync(join(dir, 'apps/readest-app/.env.test.local')), false);
  } finally {
    unlinkSync(join(dir, 'apps/readest-app/.env.local'));
    rmdirSync(join(dir, 'apps/readest-app')); rmdirSync(join(dir, 'apps')); rmdirSync(dir);
  }
});

test('isolated tests exercise cloud premium gates without the self-hosted bypass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readest-test-env-'));
  mkdirSync(join(dir, 'apps/readest-app'), { recursive: true });
  try {
    const script = resolve('scripts/ci/configure-build.mjs');
    for (const args of [['--test'], ['--test', '--cloud']]) {
      const result = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const content = readFileSync(join(dir, 'apps/readest-app/.env.local'), 'utf8');
      assert.equal(readFileSync(join(dir, 'apps/readest-app/.env.test.local'), 'utf8'), content);
      assert.ok(content.trim().split('\n').every((line) => line.startsWith('NEXT_PUBLIC_')));
      assert.match(content, /NEXT_PUBLIC_READEST_CLOUD_ENABLED="true"/);
      assert.match(content, /NEXT_PUBLIC_SELF_HOSTED="false"/);
      assert.match(content, /NEXT_PUBLIC_API_BASE_URL="http:\/\/127\.0\.0\.1:3003"/);
      assert.match(content, /NEXT_PUBLIC_SUPABASE_URL="http:\/\/127\.0\.0\.1:18000"/);
      assert.match(content, /NEXT_PUBLIC_SUPABASE_ANON_KEY="ci-public-anon-key"/);
    }
  } finally {
    for (const name of readdirSync(join(dir, 'apps/readest-app'))) unlinkSync(join(dir, 'apps/readest-app', name));
    rmdirSync(join(dir, 'apps/readest-app')); rmdirSync(join(dir, 'apps')); rmdirSync(dir);
  }
});

test('unit and browser runners load generated test settings over deployment defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'readest-test-runners-'));
  const app = join(dir, 'apps/readest-app');
  mkdirSync(app, { recursive: true });
  try {
    writeFileSync(join(app, '.env'), 'NEXT_PUBLIC_SELF_HOSTED=true\nNEXT_PUBLIC_READEST_CLOUD_ENABLED=false\n');
    writeFileSync(join(app, '.env.web'), 'NEXT_PUBLIC_SELF_HOSTED=true\nNEXT_PUBLIC_API_BASE_URL=https://deployment.example.test\n');
    const configured = spawnSync(process.execPath, [resolve('scripts/ci/configure-build.mjs'), '--test'], { cwd: dir, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    const helper = pathToFileURL(resolve('apps/readest-app/vitest.env.mts')).href;
    const checked = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { applyUnitTestEnv, loadBrowserTestEnv } from ${JSON.stringify(helper)};
      process.env.NEXT_PUBLIC_SELF_HOSTED = 'true';
      process.env.NEXT_PUBLIC_READEST_CLOUD_ENABLED = 'false';
      applyUnitTestEnv();
      for (const values of [process.env, loadBrowserTestEnv()]) {
        assert.equal(values.NEXT_PUBLIC_SELF_HOSTED, 'false');
        assert.equal(values.NEXT_PUBLIC_READEST_CLOUD_ENABLED, 'true');
        assert.equal(values.NEXT_PUBLIC_API_BASE_URL, 'http://127.0.0.1:3003');
      }
    `], { cwd: app, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    for (const name of readdirSync(app)) unlinkSync(join(app, name));
    rmdirSync(app); rmdirSync(join(dir, 'apps')); rmdirSync(dir);
  }
});
