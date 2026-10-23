import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReleaseIdentity } from './release-identity.mjs';
import { verifyReleaseAssets } from '../verify-release-assets.mjs';

async function describeFile(directory, name) {
  const path = join(directory, name);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { name, path, size: statSync(path).size, digest: `sha256:${hash.digest('hex')}` };
}

// A failed upload can resume only against the same draft, commit and bytes.
// Published releases are never edited, and existing assets are never clobbered.
export async function publishExperimental({ identity, files, notes, api, upload }) {
  if (!identity.experimental || !/^v\d+\.\d+\.\d+-x[1-9]\d*$/.test(identity.tag) ||
      !/^[a-f0-9]{40}$/.test(identity.sourceSha)) throw new Error('Invalid experimental release identity');
  const marker = `<!-- readest-source-sha: ${identity.sourceSha} -->`;
  const encodedTag = encodeURIComponent(identity.tag);
  let release = await api('GET', `releases/tags/${encodedTag}`, undefined, true);
  // The tag endpoint exposes published releases only. Authenticated listing
  // includes drafts, which is required to resume an interrupted upload.
  if (!release) {
    for (let page = 1; page <= 100; page++) {
      const releases = await api('GET', `releases?per_page=100&page=${page}`);
      const matches = releases.filter((candidate) => candidate.tag_name === identity.tag);
      if (matches.length > 1) throw new Error('Multiple drafts use this tag; resolve the conflict before retrying');
      if (matches.length) { release = matches[0]; break; }
      if (releases.length < 100) break;
      if (page === 100) throw new Error('Release history exceeded the safe draft lookup limit');
    }
  }
  if (release && (!release.draft || release.immutable)) throw new Error('Published releases are immutable; use the next -xN version');
  if (release && (release.target_commitish !== identity.sourceSha || !release.prerelease || !release.body?.includes(marker))) {
    throw new Error('Existing draft belongs to a different source commit or release channel');
  }
  let tag = await api('GET', `git/ref/tags/${encodedTag}`, undefined, true);
  if (tag) {
    let object = tag.object;
    // Resolve annotated tags without accepting a tag to a tree or blob.
    for (let depth = 0; object.type === 'tag' && depth < 8; depth++) {
      object = (await api('GET', `git/tags/${object.sha}`)).object;
    }
    if (object.type !== 'commit' || object.sha !== identity.sourceSha) throw new Error('Existing tag points to a different commit');
  }
  const previousLatest = await api('GET', 'releases/latest', undefined, true);
  if (!tag) tag = await api('POST', 'git/refs', { ref: `refs/tags/${identity.tag}`, sha: identity.sourceSha });
  if (!release) release = await api('POST', 'releases', {
    tag_name: identity.tag, target_commitish: identity.sourceSha,
    name: `${identity.productName} ${identity.version}`, body: `${notes.trim()}\n\n${marker}\n`,
    draft: true, prerelease: true, make_latest: 'false',
  });
  const existing = new Map((release.assets || []).map((asset) => [asset.name, asset]));
  for (const asset of existing.values()) {
    const file = files.find((candidate) => candidate.name === asset.name);
    if (!file || asset.state !== 'uploaded' || asset.digest !== file.digest || asset.size !== file.size) {
      throw new Error(`Draft asset differs from this build: ${asset.name}; rerun failed jobs with the original build artifacts`);
    }
  }
  for (const file of files) {
    if (!existing.has(file.name)) await upload(release, file);
  }
  // Re-read server digests before exposing the draft to users.
  const uploaded = await api('GET', `releases/${release.id}`);
  if (uploaded.assets?.length !== files.length || files.some((file) => {
    const asset = uploaded.assets.find((candidate) => candidate.name === file.name);
    return !asset || asset.state !== 'uploaded' || asset.digest !== file.digest || asset.size !== file.size;
  })) throw new Error('Uploaded release assets did not pass digest verification');
  await api('PATCH', `releases/${release.id}`, { draft: false, prerelease: true, make_latest: 'false' });
  const latest = await api('GET', 'releases/latest', undefined, true);
  if (previousLatest?.id !== latest?.id) throw new Error('Stable latest changed during publication; inspect concurrent stable releases');
  return identity.tag;
}

async function main() {
  const identity = readReleaseIdentity();
  const directory = resolve(process.argv[2] || 'release');
  verifyReleaseAssets(directory, identity.version);
  const manifest = JSON.parse(readFileSync(join(directory, 'RELEASE-METADATA.json'), 'utf8'));
  if (manifest.sourceSha !== identity.sourceSha || manifest.version !== identity.version || manifest.experimental !== true) {
    throw new Error('Downloaded artifacts belong to a different source commit or version');
  }
  const files = [];
  for (const name of readdirSync(directory)) files.push(await describeFile(directory, name));
  const checksums = new Map(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/).map((line) => {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error('Invalid checksum entry');
    return [match[2], `sha256:${match[1]}`];
  }));
  for (const file of files.filter((candidate) => candidate.name !== 'SHA256SUMS.txt')) {
    if (checksums.get(file.name) !== file.digest) throw new Error(`Checksum mismatch: ${file.name}`);
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !process.env.GH_TOKEN) throw new Error('GitHub repository and token are required');
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = async (method, path, body, allowMissing = false) => {
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
      method, headers, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  };
  const upload = async (release, file) => {
    const url = new URL(release.upload_url.split('{')[0]);
    if (url.origin !== 'https://uploads.github.com') throw new Error('Unexpected GitHub asset upload URL');
    url.searchParams.set('name', file.name);
    const response = await fetch(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
      body: createReadStream(file.path), duplex: 'half',
    });
    if (!response.ok) throw new Error(`Upload ${file.name}: HTTP ${response.status}`);
  };
  console.log(`Published ${await publishExperimental({ identity, files, notes: readFileSync(join(directory, 'RELEASE_NOTES.md'), 'utf8'), api, upload })}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
