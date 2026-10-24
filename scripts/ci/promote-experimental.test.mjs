import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateVerifiedBuild, validateArchiveEntries, validateReleaseSnapshot } from './promote-experimental.mjs';
import { expectedAssets } from '../verify-release-assets.mjs';

const sha = 'a'.repeat(40);
const names = ['resolve', 'build / metadata', 'build / aggregate', 'build / build-ios', 'build / build-android', 'build / build-macos', 'build / checks / windows', 'build / checks / workflows', 'build / checks / companions'];
const run = { id: 123, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', path: '.github/workflows/experimental-release.yml' };
const jobs = { total_count: names.length + 1, jobs: [...names.map((name) => ({ name, conclusion: 'success' })), { name: 'build / publish', conclusion: 'skipped' }] };
const artifacts = { total_count: 1, artifacts: [{ id: 456, name: 'readest-remote-0.12.12-x2', expired: false, digest: `sha256:${'b'.repeat(64)}` }] };

test('promotion accepts only a successful complete build with one verified experimental archive', () => {
  assert.equal(validateVerifiedBuild(run, jobs, artifacts, sha).version, '0.12.12-x2');
  for (const patch of [{ status: 'in_progress' }, { conclusion: 'failure' }, { event: 'pull_request' }, { path: '.github/workflows/untrusted.yml' }]) {
    assert.throws(() => validateVerifiedBuild({ ...run, ...patch }, jobs, artifacts, sha));
  }
  assert.throws(() => validateVerifiedBuild(run, { ...jobs, total_count: 99 }, artifacts, sha));
  assert.throws(() => validateVerifiedBuild(run, { ...jobs, jobs: jobs.jobs.map((job) => ({ ...job, conclusion: 'skipped' })) }, artifacts, sha));
  assert.throws(() => validateVerifiedBuild(run, { total_count: 0, jobs: [] }, artifacts, sha));
  for (const patch of [{ expired: true }, { digest: '' }, { name: 'readest-remote-0.12.12' }]) {
    assert.throws(() => validateVerifiedBuild(run, jobs, { ...artifacts, artifacts: [{ ...artifacts.artifacts[0], ...patch }] }, sha));
  }
  assert.throws(() => validateVerifiedBuild(run, jobs, { total_count: 2, artifacts: [...artifacts.artifacts, ...artifacts.artifacts] }, sha));
});

test('promotion rejects archive traversal, duplicates and missing platform artifacts before extraction', () => {
  const entries = [...expectedAssets('0.12.12-x2'), 'SHA256SUMS.txt', 'BUILDING.md', 'RELEASE-METADATA.json', 'COMPATIBILITY.md', 'RELEASE_NOTES.md'];
  validateArchiveEntries(entries, '0.12.12-x2');
  for (const invalid of [entries.slice(1), [...entries, entries[0]], [...entries, '../secret'], [...entries, '/tmp/secret']]) {
    assert.throws(() => validateArchiveEntries(invalid, '0.12.12-x2'));
  }
});

test('promotion preserves exact source identity, plugin pins and every original checksum', () => {
  const identity = { version: '0.12.12-x2', sourceSha: sha, experimental: true };
  const lock = { release: 'v0.3.0-x1' };
  const manifest = { ...identity, plugins: lock };
  const files = [...expectedAssets(identity.version), 'SHA256SUMS.txt', 'BUILDING.md', 'RELEASE-METADATA.json', 'COMPATIBILITY.md', 'RELEASE_NOTES.md'].map((name) => ({ name, digest: `sha256:${'c'.repeat(64)}` }));
  const checksums = files.filter(({ name }) => name !== 'SHA256SUMS.txt').map(({ name }) => `${'c'.repeat(64)}  ${name}`).join('\n');
  validateReleaseSnapshot(manifest, identity, lock, files, checksums);
  assert.throws(() => validateReleaseSnapshot({ ...manifest, sourceSha: 'd'.repeat(40) }, identity, lock, files, checksums));
  assert.throws(() => validateReleaseSnapshot(manifest, identity, { release: 'other' }, files, checksums));
  assert.throws(() => validateReleaseSnapshot(manifest, identity, lock, files, checksums.replace('c', 'd')));
  assert.throws(() => validateReleaseSnapshot(manifest, identity, lock, files, `${checksums}\n${checksums.split('\n')[0]}`));
});
