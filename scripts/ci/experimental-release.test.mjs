import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateReleaseIdentity } from './release-identity.mjs';
import { publishExperimental } from './publish-experimental.mjs';
import { expectedAssets } from '../verify-release-assets.mjs';

const sha = 'a'.repeat(40);
const otherSha = 'b'.repeat(40);
const config = {
  identifier: 'io.github.wenhe233.readestremote.experimental', productName: 'Readest Remote X',
  mainBinaryName: 'readest-remote', bundle: { iOS: { bundleVersion: '12012101' }, macOS: { bundleVersion: '12012101' } },
};
const identity = validateReleaseIdentity({ version: '0.12.12-x1', config, sourceSha: sha, checkedOutSha: sha, experimental: true });
const files = [{ name: 'test.zip', size: 123, digest: `sha256:${'c'.repeat(64)}` }];

test('experimental dispatch defaults to build-only and forwards publication separately from frozen SHA', () => {
  const workflow = readFileSync('.github/workflows/experimental-release.yml', 'utf8');
  const inputs = workflow.split('\njobs:')[0];
  assert.match(inputs, /publish:\s+description:[^\n]+\s+type: boolean\s+default: false/);
  assert.match(workflow, /source_sha: \$\{\{ needs.resolve.outputs.source_sha \}\}/);
  assert.match(workflow, /publish: \$\{\{ inputs.publish \}\}/);
  assert.doesNotMatch(workflow, /publish: true/);
  const reusable = readFileSync('.github/workflows/release-build.yml', 'utf8');
  assert.match(reusable, /\n  publish:\s+if: inputs.publish/);
  assert.match(reusable, /name: readest-remote-\$\{\{ needs.metadata.outputs.version \}\}/);
});

test('experimental identity uses committed version, isolated app and exact source SHA', () => {
  assert.equal(identity.tag, 'v0.12.12-x1');
  assert.equal(identity.productName, 'Readest Remote X');
  assert.equal(expectedAssets(identity.version).length, 19);
  for (const patch of [
    { sourceSha: 'exp/network-sources' }, { checkedOutSha: otherSha }, { version: '0.12.12' },
    { version: '0.12.12-x0' }, { version: '0.12.12-x01' }, { version: '0.12.12-x1.1' },
    { experimental: false }, { config: { ...config, identifier: 'io.github.wenhe233.readestremote' } },
    { config: { ...config, productName: 'Readest Remote Experimental' } },
    { config: { ...config, bundle: { ...config.bundle, createUpdaterArtifacts: true } } },
  ]) assert.throws(() => validateReleaseIdentity({ version: '0.12.12-x1', config, sourceSha: sha, checkedOutSha: sha, experimental: true, ...patch }));
  assert.throws(() => validateReleaseIdentity({
    version: '0.12.12-r2', sourceSha: sha, checkedOutSha: sha, experimental: false, refType: 'tag', refName: 'v0.12.12-r1',
    config: { ...config, identifier: 'io.github.wenhe233.readestremote', productName: 'Readest Remote' },
  }), /does not match/);
});

function fakeGitHub({ draft, tagSha, uploadFails = false, badDigest = false } = {}) {
  const calls = [];
  let current = draft;
  let reference = tagSha && { object: { type: 'commit', sha: tagSha } };
  return {
    calls,
    api: async (method, path, body) => {
      calls.push({ method, path, body });
      if (method === 'GET' && path.startsWith('releases/tags/')) return current?.draft ? undefined : current;
      if (method === 'GET' && path.startsWith('releases?per_page=100&page=')) return current ? [current] : [];
      if (method === 'GET' && path.startsWith('git/ref/tags/')) return reference;
      if (method === 'GET' && path === 'releases/latest') return { id: 10 };
      if (method === 'POST' && path === 'git/refs') return reference = { object: { type: 'commit', sha: body.sha } };
      if (method === 'POST' && path === 'releases') return current = { ...body, id: 20, assets: [] };
      if (method === 'GET' && path === 'releases/20') return current;
      if (method === 'PATCH' && path === 'releases/20') return current = { ...current, ...body };
      throw new Error(`Unexpected API request: ${method} ${path}`);
    },
    upload: async (_release, file) => {
      calls.push({ method: 'UPLOAD', path: file.name });
      if (uploadFails) throw new Error('connection closed');
      current.assets.push({ ...file, state: 'uploaded', digest: badDigest ? 'wrong' : file.digest });
    },
  };
}

const matchingDraft = (extra = {}) => ({
  id: 20, tag_name: identity.tag, draft: true, prerelease: true, target_commitish: sha,
  body: `<!-- readest-source-sha: ${sha} -->`, assets: [], ...extra,
});
const run = (server) => publishExperimental({ identity, files, notes: 'Test release.', ...server });

test('publishes only verified assets as prerelease and leaves latest unchanged', async () => {
  const server = fakeGitHub();
  assert.equal(await run(server), identity.tag);
  assert.deepEqual(server.calls.find((call) => call.path === 'git/refs').body, { ref: 'refs/tags/v0.12.12-x1', sha });
  const created = server.calls.find((call) => call.method === 'POST' && call.path === 'releases').body;
  assert.equal(created.target_commitish, sha);
  assert.equal(created.draft, true);
  assert.equal(created.prerelease, true);
  assert.equal(created.make_latest, 'false');
  assert.deepEqual(server.calls.find((call) => call.method === 'PATCH').body, { draft: false, prerelease: true, make_latest: 'false' });
});

test('never edits published releases, mismatched drafts or conflicting tags', async () => {
  for (const options of [
    { draft: matchingDraft({ draft: false }) }, { draft: matchingDraft({ target_commitish: otherSha }) },
    { draft: matchingDraft({ prerelease: false }) }, { draft: matchingDraft({ body: '' }) }, { tagSha: otherSha },
  ]) {
    const server = fakeGitHub(options);
    await assert.rejects(run(server), /immutable|different/);
    assert.ok(server.calls.every((call) => call.method === 'GET'));
  }
});

test('resumes matching draft without overwriting existing assets', async () => {
  const server = fakeGitHub({ draft: matchingDraft({ assets: [{ ...files[0], state: 'uploaded' }] }), tagSha: sha });
  await run(server);
  assert.ok(server.calls.every((call) => !['UPLOAD', 'POST', 'DELETE'].includes(call.method)));
  for (const asset of [
    { ...files[0], digest: 'different', state: 'uploaded' }, { ...files[0], state: 'starter' },
    { ...files[0], name: 'foreign.zip', state: 'uploaded' },
  ]) {
    const incompatible = fakeGitHub({ draft: matchingDraft({ assets: [asset] }), tagSha: sha });
    await assert.rejects(run(incompatible), /Draft asset differs/);
    assert.ok(incompatible.calls.every((call) => call.method === 'GET'));
  }
});

test('upload failure or corrupt server digest leaves release unpublished', async () => {
  for (const options of [{ uploadFails: true }, { badDigest: true }]) {
    const server = fakeGitHub(options);
    await assert.rejects(run(server), /connection closed|digest verification/);
    assert.ok(server.calls.every((call) => call.method !== 'PATCH'));
  }
});

test('every release and reusable check checkout explicitly selects source SHA', () => {
  for (const path of ['.github/workflows/release-build.yml', '.github/workflows/pull-request.yml']) {
    const content = readFileSync(path, 'utf8');
    const checkouts = content.split(/- uses: actions\/checkout@/).slice(1);
    assert.ok(checkouts.length > 1);
    for (const checkout of checkouts) {
      const step = checkout.split(/\n {6}- /)[0];
      assert.match(step, /ref: \$\{\{ inputs.source_sha(?: \|\| github.sha)? \}\}/);
      assert.match(step, /persist-credentials: false/);
    }
  }
  assert.match(readFileSync('.github/workflows/release.yml', 'utf8'), /'!v\*-x\[0-9\]\*'/);
});
