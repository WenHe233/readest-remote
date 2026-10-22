import { execFileSync, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { assertContainedPath, createWorktree, parseWorktreeOptions } from './worktree-setup.ts';

// Submodules skipped during worktree setup (shared via symlinks or pre-built)
const SKIPPED_SUBMODULES = [
  'apps/readest-app/.claude/skills/gstack', // shared via .claude symlink
  'packages/simplecc-wasm', // committed dist/web is copied in below
];

const options = parseWorktreeOptions(process.argv.slice(2));
const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

// Keep stdout available for the final path; never interpolate refs or paths into a shell.
const gitStdio: StdioOptions = ['inherit', process.stderr, process.stderr];
const git = (args: string[], cwd = repoRoot) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['inherit', 'pipe', process.stderr] });
const runPnpm = (args: string[], cwd: string) => {
  const pnpmScript = process.env['npm_execpath'];
  if (!pnpmScript) throw new Error('Run this script through pnpm worktree:new.');
  execFileSync(process.execPath, [pnpmScript, ...args], { cwd, stdio: gitStdio });
};
const worktreePath = createWorktree(options, repoRoot, {
  git,
  gh: (args) => execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8' }),
  pathExists: (target) => {
    try {
      fs.lstatSync(target);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return false;
    }
  },
});

// Repoint submodule URLs to local .git/modules/ clones to avoid remote fetches.
// Submodules without a local cache fall back to the remote URL.
console.error('\n--- Initializing submodules (using local objects) ---');
const gitDir = git(['rev-parse', '--git-common-dir']).trim();
const absGitDir = path.resolve(repoRoot, gitDir);
const submoduleNames = git(
  ['config', '--file', '.gitmodules', '--get-regexp', 'submodule\\..*\\.path'],
  worktreePath,
)
  .trim()
  .split('\n')
  .map((line) => {
    // line: submodule.<name>.path <path>
    const match = line.match(/^submodule\.(.+)\.path\s+(.+)$/);
    return { name: match![1]!, subPath: match![2]! };
  })
  .filter(({ subPath }) => !SKIPPED_SUBMODULES.includes(subPath));

for (const { name, subPath } of submoduleNames) {
  const localModuleDir = path.join(absGitDir, 'modules', subPath);
  // Also check if the submodule has a full .git/ directory (cloned outside of git's modules cache)
  const subGitDir = path.join(repoRoot, subPath, '.git');
  let localDir: string | undefined;
  if (fs.existsSync(localModuleDir)) {
    localDir = localModuleDir;
    console.error(`  ${subPath} -> local (.git/modules)`);
  } else if (fs.existsSync(subGitDir)) {
    localDir = fs.statSync(subGitDir).isDirectory()
      ? subGitDir
      : path.resolve(
          path.join(repoRoot, subPath),
          fs.readFileSync(subGitDir, 'utf8').replace('gitdir: ', '').trim(),
        );
    console.error(`  ${subPath} -> local (standalone .git)`);
  } else {
    console.error(`  ${subPath} -> remote (no local cache)`);
  }
  if (localDir) {
    // Allow fetching any commit (not just branch tips) from the local source
    git(['-C', localDir, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
    git(['-C', worktreePath, 'config', `submodule.${name}.url`, localDir]);
  }
}

for (const { subPath } of submoduleNames) {
  git(
    [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--recursive',
      '--',
      subPath,
    ],
    worktreePath,
  );
}

// Restore original remote URLs so `git push` in submodules works correctly
for (const { name } of submoduleNames) {
  const origUrl = git(
    ['config', '--file', '.gitmodules', `submodule.${name}.url`],
    worktreePath,
  ).trim();
  git(['-C', worktreePath, 'config', `submodule.${name}.url`, origUrl]);
}

// Install dependencies
console.error('\n--- Installing dependencies ---');
runPnpm(['install'], worktreePath);

// Copy .env* files from the app directory to the new worktree's app directory
const appRelPath = 'apps/readest-app';
const srcAppDir = path.join(repoRoot, appRelPath);
const dstAppDir = path.join(worktreePath, appRelPath);
const envFiles = fs.readdirSync(srcAppDir).filter((f) => f.startsWith('.env'));
if (envFiles.length > 0) {
  console.error(`\n--- Copying ${envFiles.length} .env* files ---`);
  for (const envFile of envFiles) {
    const src = path.join(srcAppDir, envFile);
    const dst = path.join(dstAppDir, envFile);
    if (!fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      console.error(`  ${envFile}`);
    }
  }
}

// Symlink target so the worktree shares the Rust build cache
const srcTarget = path.join(repoRoot, 'target');
const dstTarget = path.join(worktreePath, 'target');
if (fs.existsSync(srcTarget) && !fs.existsSync(dstTarget)) {
  console.error('\n--- Symlinking src-tauri/target ---');
  fs.symlinkSync(srcTarget, dstTarget, 'junction');
}

// Initialize Tauri Android gen directory (needs platform-specific paths regenerated)
const genDir = path.join(dstAppDir, 'src-tauri', 'gen');
const androidGenDir = path.join(genDir, 'android');
if (fs.existsSync(androidGenDir)) {
  console.error('\n--- Initializing Tauri Android ---');
  assertContainedPath(worktreePath, androidGenDir);
  assertContainedPath(worktreePath, path.join(dstAppDir, 'src-tauri', 'icons'));
  fs.rmSync(androidGenDir, { recursive: true });
  runPnpm(['tauri', 'android', 'init'], dstAppDir);
  runPnpm(['tauri', 'icon', '../../data/icons/readest-book.png'], dstAppDir);
  git(
    ['checkout', '--', `${appRelPath}/src-tauri/gen/android`, `${appRelPath}/src-tauri/icons`],
    worktreePath,
  );
}

// Copy Tauri iOS gen from the bare repo, skipping rebuildable artifacts so
// the worktree owns its own Xcode project. `project.yml` and the Xcode build
// script walk up to `../../src` / `../../Cargo.toml`, which now resolve to
// the worktree's Rust source instead of the bare repo's — so `pnpm tauri ios
// dev` from a worktree actually builds the worktree's code. Symlinking
// silently routed every iOS build through the bare repo, even when running
// `pnpm tauri ios dev` from a worktree path.
//
// Skipped: `build/` (~300 MB of Xcode derived output), `Externals/<arch>/
// {debug,release}/` (Rust static libs — rebuilt against the worktree's
// src-tauri), per-user Xcode state, and `Pods/` (defensive; Readest's iOS
// uses SPM, not Cocoapods).
const appleGenDir = path.join(genDir, 'apple');
const srcAppleGen = path.join(srcAppDir, 'src-tauri', 'gen', 'apple');
if (fs.existsSync(srcAppleGen) && !fs.existsSync(appleGenDir)) {
  console.error('\n--- Copying Tauri iOS gen ---');
  fs.cpSync(srcAppleGen, appleGenDir, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const rel = path.relative(srcAppleGen, src).split(path.sep).join('/');
      if (rel === 'build' || rel.startsWith('build/')) return false;
      if (/^Externals\/[^/]+\/(debug|release)(\/|$)/.test(rel)) return false;
      if (rel.endsWith('/xcuserdata') || rel.includes('/xcuserdata/')) return false;
      if (rel.endsWith('.xcuserstate')) return false;
      if (rel === 'Pods' || rel.startsWith('Pods/')) return false;
      return true;
    },
  });
}

// Symlink the remaining shared gen dirs (schemas are generated at build time
// and don't differ per branch; keystore.properties is signing config that
// must stay identical across worktrees to produce matching APKs).
for (const sub of ['schemas', 'android/keystore.properties']) {
  const src = path.join(srcAppDir, 'src-tauri', 'gen', sub);
  const dst = path.join(genDir, sub);
  if (fs.existsSync(src) && !fs.existsSync(dst)) {
    console.error(`  Symlinking src-tauri/gen/${sub}`);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, fs.statSync(src).isDirectory() ? 'junction' : 'file');
  }
}

// Copy public/vendor to the new worktree (built assets not in git)
const srcVendor = path.join(srcAppDir, 'public', 'vendor');
const dstVendor = path.join(dstAppDir, 'public', 'vendor');
if (fs.existsSync(srcVendor) && !fs.existsSync(dstVendor)) {
  console.error('\n--- Copying public/vendor ---');
  fs.cpSync(srcVendor, dstVendor, { recursive: true });
}

// `packages/simplecc-wasm` is a skipped submodule (SKIPPED_SUBMODULES), but the
// @simplecc alias resolves straight into its committed `dist/web`, so the new
// worktree needs that directory to build.
const srcSimplecc = path.join(repoRoot, 'packages', 'simplecc-wasm', 'dist');
const dstSimplecc = path.join(worktreePath, 'packages', 'simplecc-wasm', 'dist');
if (fs.existsSync(srcSimplecc) && !fs.existsSync(dstSimplecc)) {
  console.error('\n--- Copying packages/simplecc-wasm/dist ---');
  fs.cpSync(srcSimplecc, dstSimplecc, { recursive: true });
}

// Print path to stdout -- allows: cd $(pnpm worktree:new <arg>)
process.stdout.write(worktreePath + '\n');
