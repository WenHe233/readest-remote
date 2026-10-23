import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expectedAssets } from '../verify-release-assets.mjs';

export function validateReleaseIdentity({ version, config, sourceSha, checkedOutSha, experimental, refType, refName }) {
  expectedAssets(version);
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '') || sourceSha !== checkedOutSha) {
    throw new Error('Release source must be the exact checked-out 40-character commit SHA');
  }
  const isExperimental = /^\d+\.\d+\.\d+-x[1-9]\d*$/.test(version);
  if (experimental !== isExperimental || (!experimental && /-x\d/.test(version))) {
    throw new Error('Experimental releases require <base>-xN (N >= 1); stable releases cannot use -xN');
  }
  const identifier = `io.github.wenhe233.readestremote${experimental ? '.experimental' : ''}`;
  const productName = `Readest Remote${experimental ? ' X' : ''}`;
  if (config.identifier !== identifier || config.productName !== productName || config.bundle?.createUpdaterArtifacts) {
    throw new Error('Invalid release application identity or enabled updater artifacts');
  }
  const code = Number(config.bundle?.iOS?.bundleVersion);
  if (!Number.isSafeInteger(code) || code < 1 || code > 2100000000 || Number(config.bundle?.macOS?.bundleVersion) !== code) {
    throw new Error('Android/Apple builds require matching positive numeric internal build versions');
  }
  const binaryName = config.mainBinaryName;
  if (!/^[a-z][a-z0-9-]*$/.test(binaryName || '')) throw new Error('Invalid release binary name');
  const tag = `v${version}`;
  if (!experimental && refType === 'tag' && refName !== tag) throw new Error(`Tag ${refName} does not match ${tag}`);
  return { version, tag, sourceSha, experimental, identifier, productName, binaryName, buildNumber: code };
}

export function readReleaseIdentity() {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  return validateReleaseIdentity({
    version: read('apps/readest-app/package.json').version,
    config: read('apps/readest-app/src-tauri/tauri.conf.json'),
    sourceSha: process.env.RELEASE_SOURCE_SHA,
    checkedOutSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    experimental: process.env.RELEASE_EXPERIMENTAL === 'true',
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const identity = readReleaseIdentity();
  const manifestIndex = process.argv.indexOf('--manifest');
  if (manifestIndex !== -1) {
    const lock = JSON.parse(readFileSync('external-plugins.lock.json', 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(lock.revision || '') || !lock.assets ||
        Object.values(lock.assets).some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('Plugin release lock must pin a commit and asset SHA-256 digests');
    }
    writeFileSync(process.argv[manifestIndex + 1], `${JSON.stringify({ ...identity, plugins: lock }, null, 2)}\n`);
  } else if (process.env.GITHUB_OUTPUT) {
    const outputs = {
      version: identity.version, tag: identity.tag, android_code: identity.buildNumber,
      identifier: identity.identifier, product_name: identity.productName, binary_name: identity.binaryName,
    };
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(`Validated ${identity.tag} at ${identity.sourceSha} (${identity.identifier}).`);
}
