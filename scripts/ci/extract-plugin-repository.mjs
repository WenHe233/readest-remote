import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/readest-app/package.json', import.meta.url));
const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = require('@zip.js/zip.js');

/** Replace this build's extracted repository only after the whole archive was validated. */
export async function extractPluginRepository(bytes, workspace, validate) {
  if (typeof validate !== 'function') throw new Error('A staged repository validator is required');
  const artifacts = join(realpathSync(resolve(workspace)), '.v2-artifacts');
  if (existsSync(artifacts) && lstatSync(artifacts).isSymbolicLink())
    throw new Error('Plugin artifact directory must not be a symlink or junction');
  mkdirSync(artifacts, { recursive: true });
  const parent = realpathSync(artifacts);
  const repository = join(parent, 'repository');
  const assertControlled = (directory) => {
    const path = resolve(directory);
    if (dirname(path) !== parent || (basename(path) !== 'repository' && !basename(path).startsWith('repository-staging-')))
      throw new Error('Plugin extraction is outside the controlled artifact directory');
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || realpathSync(path) !== path))
      throw new Error('Plugin extraction target must be a real artifact directory');
  };
  assertControlled(repository);
  const stage = mkdtempSync(join(parent, 'repository-staging-'));
  const reader = new ZipReader(new Uint8ArrayReader(bytes));
  try {
    const entries = await reader.getEntries();
    const seen = new Set();
    for (const entry of entries) {
      if (entry.directory || !/^(repo\.json|index\.json|local\.readest-repo|plugins\/[a-z0-9.-]+\.readest-plugin)$/.test(entry.filename) || seen.has(entry.filename))
        throw new Error('Unexpected source archive entry');
      seen.add(entry.filename);
      const path = join(stage, entry.filename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, await entry.getData(new Uint8ArrayWriter()));
    }
    if (!seen.has('repo.json') || !seen.has('index.json')) throw new Error('Source archive has no repository metadata');
    await validate(stage);
    // Both recursive cleanup targets are absolute, constrained and checked immediately before removal.
    assertControlled(repository);
    if (existsSync(repository)) rmSync(repository, { recursive: true });
    assertControlled(stage);
    renameSync(stage, repository);
    return repository;
  } finally {
    await reader.close();
    if (existsSync(stage)) {
      assertControlled(stage);
      rmSync(stage, { recursive: true });
    }
  }
}
