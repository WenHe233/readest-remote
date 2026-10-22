import fs from 'node:fs';
import path from 'node:path';

export interface WorktreeOptions {
  target: string;
  base?: string;
}

interface WorktreeHost {
  git: (args: string[]) => string;
  gh: (args: string[]) => string;
  pathExists: (target: string) => boolean;
}

export function parseWorktreeOptions(args: string[]): WorktreeOptions {
  const [target, flag, base, ...extra] = args;
  if (
    !target ||
    target.startsWith('-') ||
    /[\x00-\x1f]/.test(target) ||
    extra.length ||
    (flag !== undefined && (flag !== '--base' || !base || base.startsWith('-'))) ||
    (base !== undefined && /[\x00-\x1f]/.test(base))
  ) {
    throw new Error('Usage: pnpm worktree:new <branch-name|pr-number> [--base <ref>]');
  }
  if (/^\d+$/.test(target) && base !== undefined) {
    throw new Error('--base only applies to new branches, not pull requests.');
  }
  return { target, ...(base === undefined ? {} : { base }) };
}

/** Reject links in ancestors too: deleting a child of a junction deletes the linked target's data. */
export function assertContainedPath(workspace: string, target: string): void {
  const root = path.resolve(workspace);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path must be inside the worktree: ${target}`);
  }
  let ancestor = resolved;
  while (ancestor !== root) {
    try {
      if (fs.lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(`Refusing to modify a generated path through a symlink: ${ancestor}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    ancestor = path.dirname(ancestor);
  }
  if (fs.lstatSync(root).isSymbolicLink()) {
    throw new Error(`Worktree root must not be a symlink: ${root}`);
  }
}

/** Only creates/checks out a branch. Existing local histories are never reset or rebased. */
export function createWorktree(
  options: WorktreeOptions,
  repoRoot: string,
  host: WorktreeHost,
): string {
  const { target, base } = options;
  const isPr = /^\d+$/.test(target);
  const localBranch = isPr ? `pr-${target}` : target;
  // Branch names can contain characters Windows cannot represent in a directory.
  const directory = `readest-${localBranch.replace(/[/\\<>:"|?*]/g, '-')}`;
  const destination = path.join(path.dirname(repoRoot), directory);
  if (host.pathExists(destination)) {
    throw new Error(
      `Worktree path already exists: ${destination}. Choose another branch or remove it explicitly.`,
    );
  }
  host.git(['check-ref-format', '--branch', localBranch]);
  let existingBranch = false;
  try {
    host.git(['show-ref', '--verify', '--quiet', `refs/heads/${localBranch}`]);
    existingBranch = true;
  } catch {
    // show-ref exits nonzero when the branch does not exist.
  }
  if (existingBranch) {
    if (base) throw new Error('--base cannot be used with an existing branch.');
    host.git(['worktree', 'add', destination, localBranch]);
    return destination;
  }
  if (isPr) {
    const pr = JSON.parse(
      host.gh(['pr', 'view', target, '--json', 'headRefName,headRepositoryOwner,headRepository']),
    ) as {
      headRefName: string;
      headRepositoryOwner: { login: string };
      headRepository: { name: string };
    };
    const owner = pr.headRepositoryOwner.login;
    const repository = pr.headRepository.name;
    if (!/^[a-z\d-]+$/i.test(owner) || !/^[\w.-]+$/.test(repository)) {
      throw new Error('Invalid pull request repository metadata.');
    }
    host.git(['check-ref-format', '--branch', pr.headRefName]);
    const origin = host
      .git(['remote', 'get-url', 'origin'])
      .trim()
      .replace(/\.git$/, '');
    const sameRepository =
      origin.endsWith(`/${owner}/${repository}`) || origin.endsWith(`:${owner}/${repository}`);
    const remote = sameRepository ? 'origin' : `pr-${owner}`;
    if (!sameRepository) {
      const forkUrl = `https://github.com/${owner}/${repository}.git`;
      let existingUrl: string | undefined;
      try {
        existingUrl = host.git(['remote', 'get-url', remote]).trim();
      } catch {
        /* new remote */
      }
      if (existingUrl && existingUrl !== forkUrl) {
        throw new Error(
          `Remote ${remote} points to another repository. Resolve it before retrying.`,
        );
      }
      if (!existingUrl) host.git(['remote', 'add', remote, forkUrl]);
    }
    host.git(['fetch', remote, `refs/heads/${pr.headRefName}:refs/heads/${localBranch}`]);
    host.git(['worktree', 'add', destination, localBranch]);
    host.git(['-C', destination, 'config', `branch.${localBranch}.remote`, remote]);
    host.git([
      '-C',
      destination,
      'config',
      `branch.${localBranch}.merge`,
      `refs/heads/${pr.headRefName}`,
    ]);
    return destination;
  }
  host.git(['fetch', 'origin']);
  let selectedBase = base;
  if (!selectedBase) {
    const head = host.git(['ls-remote', '--symref', 'origin', 'HEAD']);
    const branch = head.match(/^ref: refs\/heads\/(.+)\s+HEAD$/m)?.[1];
    if (!branch) throw new Error('Cannot resolve the origin default branch. Specify --base <ref>.');
    selectedBase = `origin/${branch}`;
  }
  // Resolve first so a moving ref cannot select a different commit during setup.
  const sha = host
    .git(['rev-parse', '--verify', '--end-of-options', `${selectedBase}^{commit}`])
    .trim();
  host.git(['worktree', 'add', '-b', localBranch, destination, sha]);
  return destination;
}
