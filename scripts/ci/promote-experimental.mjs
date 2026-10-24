import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, createWriteStream, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { expectedAssets } from '../verify-release-assets.mjs';

export function validateVerifiedBuild(run, jobs, artifacts, sourceSha) {
  assert.match(sourceSha, /^[a-f0-9]{40}$/);
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.path, '.github/workflows/experimental-release.yml');
  assert.equal(jobs.jobs.length, jobs.total_count, 'Incomplete job listing');
  for (const job of jobs.jobs) {
    assert.equal(job.conclusion, job.name === 'build / publish' ? 'skipped' : 'success', job.name);
  }
  for (const name of ['resolve', 'build / metadata', 'build / aggregate', 'build / build-ios', 'build / build-android', 'build / build-macos', 'build / checks / windows', 'build / checks / workflows', 'build / checks / companions']) {
    assert.ok(jobs.jobs.some((job) => job.name === name), `Missing gate: ${name}`);
  }
  assert.equal(artifacts.artifacts.length, artifacts.total_count, 'Incomplete artifact listing');
  const matches = artifacts.artifacts.filter((artifact) => /^readest-remote-\d+\.\d+\.\d+-x[1-9]\d*$/.test(artifact.name));
  assert.equal(matches.length, 1, 'Expected one aggregate experimental artifact');
  const artifact = matches[0];
  assert.equal(artifact.expired, false);
  assert.match(artifact.digest, /^sha256:[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
  return { artifact, version: artifact.name.slice('readest-remote-'.length), sourceSha, runId: run.id };
}

export function validateArchiveEntries(entries, version) {
  const names = [...expectedAssets(version), 'SHA256SUMS.txt', 'BUILDING.md', 'RELEASE-METADATA.json', 'COMPATIBILITY.md', 'RELEASE_NOTES.md'];
  assert.deepEqual([...entries].sort(), names.sort(), 'Unexpected, duplicate or missing archive entry');
}

export function validateReleaseSnapshot(manifest, identity, lock, files, checksumText) {
  for (const [key, value] of Object.entries(identity)) assert.deepEqual(manifest[key], value, `Release identity: ${key}`);
  assert.deepEqual(manifest.plugins, lock, 'Plugin pins differ');
  validateArchiveEntries(files.map((file) => file.name), identity.version);
  const checksums = new Map();
  for (const line of checksumText.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    assert.ok(match, 'Invalid checksum entry');
    assert.ok(!checksums.has(match[2]), 'Duplicate checksum entry');
    checksums.set(match[2], `sha256:${match[1]}`);
  }
  assert.equal(checksums.size, files.length - 1);
  for (const file of files) {
    if (file.name !== 'SHA256SUMS.txt') assert.equal(checksums.get(file.name), file.digest, file.name);
  }
}

async function main() {
  const mode = process.argv[2];
  assert.ok(['inspect', 'download', 'publish'].includes(mode));
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.SOURCE_RUN_ID;
  const sourceSha = process.env.SOURCE_SHA;
  assert.match(repo || '', /^[\w.-]+\/[\w.-]+$/);
  assert.match(runId || '', /^[1-9]\d{0,15}$/);
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/);
  assert.ok(process.env.GH_TOKEN, 'Missing GitHub token');
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = async (method, path, body, allowMissing = false) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, redirect: 'error', signal: AbortSignal.timeout(120_000),
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const [run, jobs, artifacts] = await Promise.all([
    api('GET', `actions/runs/${runId}`),
    api('GET', `actions/runs/${runId}/jobs?per_page=100`),
    api('GET', `actions/runs/${runId}/artifacts?per_page=100`),
  ]);
  const verified = validateVerifiedBuild(run, jobs, artifacts, sourceSha);
  assert.equal(String(verified.runId), runId);
  const statePath = resolve('.promotion-info.json');
  if (mode === 'inspect') {
    writeFileSync(statePath, JSON.stringify(verified));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${verified.artifact.id}\nartifact_name=${verified.artifact.name}\nversion=${verified.version}\n`);
    console.log(`Verified build ${runId}: ${verified.artifact.name}`);
    return;
  }
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')), verified, 'Build or artifact state changed');
  const directory = resolve('release');
  if (mode === 'download') {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${verified.artifact.id}/zip`, {
      headers, redirect: 'manual', signal: AbortSignal.timeout(120_000),
    });
    assert.equal(response.status, 302, 'Expected a signed GitHub artifact URL');
    const location = new URL(response.headers.get('location'));
    assert.equal(location.protocol, 'https:');
    // Do not forward the repository token to artifact storage.
    const archive = await fetch(location, { signal: AbortSignal.timeout(900_000), redirect: 'error' });
    assert.equal(archive.status, 200);
    const hash = createHash('sha256');
    const archivePath = resolve('verified-artifacts.zip');
    await pipeline(Readable.fromWeb(archive.body), new Transform({
      transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
    }), createWriteStream(archivePath, { flags: 'wx' }));
    assert.equal(`sha256:${hash.digest('hex')}`, verified.artifact.digest, 'Artifact archive digest mismatch');
    const entries = execFileSync('unzip', ['-Z1', archivePath], { encoding: 'utf8' }).trim().split(/\r?\n/);
    validateArchiveEntries(entries, verified.version);
    mkdirSync(directory);
    execFileSync('unzip', ['-q', archivePath, '-d', directory]);
    const manifest = JSON.parse(readFileSync(join(directory, 'RELEASE-METADATA.json'), 'utf8'));
    assert.equal(manifest.sourceSha, sourceSha, 'Archive belongs to a different source commit');
    assert.equal(manifest.version, verified.version);
    assert.equal(manifest.experimental, true);
    console.log('Verified the original artifact archive digest and extracted the exact release files.');
    return;
  }
  const manifest = JSON.parse(readFileSync(join(directory, 'RELEASE-METADATA.json'), 'utf8'));
  assert.equal(manifest.sourceSha, sourceSha, 'Reject a different source before loading its publisher');
  assert.equal(manifest.version, verified.version);
  assert.equal(manifest.experimental, true);
  const source = resolve('source');
  const fromSource = async (file) => import(pathToFileURL(join(source, file)).href);
  const { readReleaseIdentity } = await fromSource('scripts/ci/release-identity.mjs');
  const { validateExperimentalPluginLock } = await fromSource('scripts/ci/experimental-plugins.mjs');
  const { publishExperimental } = await fromSource('scripts/ci/publish-experimental.mjs');
  process.env.RELEASE_SOURCE_SHA = sourceSha;
  process.env.RELEASE_EXPERIMENTAL = 'true';
  process.chdir(source);
  const identity = readReleaseIdentity();
  assert.equal(identity.version, verified.version);
  const lock = JSON.parse(readFileSync('external-plugins.lock.json', 'utf8'));
  validateExperimentalPluginLock(lock);
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), `Non-regular asset: ${name}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    files.push({ name, path, size: stat.size, digest: `sha256:${hash.digest('hex')}` });
  }
  validateReleaseSnapshot(manifest, identity, lock, files, readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8'));
  const notes = process.env.RELEASE_NOTES?.trim();
  assert.ok(notes && notes.length <= 60_000, 'Release notes required');
  const upload = async (release, file) => {
    const url = new URL(release.upload_url.split('{')[0]);
    assert.equal(url.origin, 'https://uploads.github.com');
    url.searchParams.set('name', file.name);
    console.log(`Uploading ${file.name}`);
    const response = await fetch(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
      body: createReadStream(file.path), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok) throw new Error(`Upload ${file.name}: HTTP ${response.status}`);
  };
  console.log(`Published ${await publishExperimental({ identity, files, notes, api, upload })} from verified run ${runId}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
