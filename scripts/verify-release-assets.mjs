// Artifact matrix and validation adapted from feat/kavita-v1.
import { existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function expectedAssets(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const prefix = `Readest-Remote_${version}`;
  return [
    'windows-x64-setup.exe', 'windows-x64-portable.exe',
    'windows-arm64-setup.exe', 'windows-arm64-portable.exe',
    'linux-x64.AppImage', 'linux-x64.deb', 'linux-arm64.AppImage', 'linux-arm64.deb',
    'macos-universal.dmg', 'android-universal.apk', 'android-arm64.apk', 'ios-arm64.ipa',
    'web.zip', 'koreader-plugin.zip', 'calibre-plugin.zip', 'browser-extension.zip',
    'plugin-source.zip', 'plugin-sdk.tgz', 'plugin-examples.zip',
  ].map((name) => `${prefix}_${name}`);
}

export function verifyReleaseAssets(directory, version) {
  const expected = expectedAssets(version);
  const errors = [];
  for (const name of expected) {
    const path = join(directory, name);
    if (!existsSync(path)) errors.push(`missing ${name}`);
    else if (!lstatSync(path).isFile() || lstatSync(path).size === 0) errors.push(`empty or non-regular ${name}`);
  }
  for (const name of existsSync(directory) ? readdirSync(directory) : []) {
    if (!expected.includes(name) && !['SHA256SUMS.txt', 'BUILDING.md', 'RELEASE-METADATA.json', 'COMPATIBILITY.md', 'RELEASE_NOTES.md'].includes(name)) errors.push(`unexpected ${name}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [directory = 'release', version = process.env.RELEASE_VERSION] = process.argv.slice(2);
    console.log(`Verified ${verifyReleaseAssets(resolve(directory), version).length} V2 artifacts.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
