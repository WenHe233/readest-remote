// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertContainedPath, createWorktree, parseWorktreeOptions } from './worktree-setup.ts';

const root = path.resolve('fixtures/main-checkout');
const destination = path.join(path.dirname(root), 'readest-exp-network-sources');
const baseSha = 'a'.repeat(40);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function host(existingBranch = false) {
  const git = vi.fn((args: string[]) => {
    if (args[0] === 'show-ref' && !existingBranch) throw new Error('Missing branch');
    if (args[0] === 'rev-parse') return baseSha;
    if (args[0] === 'ls-remote') return 'ref: refs/heads/trunk\tHEAD\n';
    if (args[0] === 'remote') return 'https://github.com/owner/project.git';
    return '';
  });
  const gh = vi.fn(() =>
    JSON.stringify({
      headRefName: 'feature/source',
      headRepositoryOwner: { login: 'owner' },
      headRepository: { name: 'project' },
    }),
  );
  return { git, gh, pathExists: vi.fn(() => false) };
}

describe('worktree creation', () => {
  it('parses an explicit base and rejects ambiguous or option-like inputs', () => {
    expect(parseWorktreeOptions(['exp/network-sources', '--base', 'origin/feature'])).toEqual({
      target: 'exp/network-sources',
      base: 'origin/feature',
    });
    for (const args of [[], ['-bad'], ['branch', '--base'], ['branch', '--force'], ['a', 'b']]) {
      expect(() => parseWorktreeOptions(args)).toThrow();
    }
    expect(() => parseWorktreeOptions(['branch', '--base', '--upload-pack=evil'])).toThrow();
    expect(() => parseWorktreeOptions(['3837', '--base', 'main'])).toThrow();
  });

  it('starts a new branch at the exact explicit base commit, without a rebase', () => {
    const runtime = host();
    expect(
      createWorktree({ target: 'exp/network-sources', base: 'origin/feature' }, root, runtime),
    ).toBe(destination);
    expect(runtime.git).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--end-of-options',
      'origin/feature^{commit}',
    ]);
    expect(runtime.git).toHaveBeenCalledWith([
      'worktree',
      'add',
      '-b',
      'exp/network-sources',
      destination,
      baseSha,
    ]);
    expect(runtime.git.mock.calls.some(([args]) => args[0] === 'rebase')).toBe(false);
    expect(runtime.git.mock.calls.some(([args]) => args[0] === 'ls-remote')).toBe(false);
  });

  it('discovers the advertised remote default instead of assuming origin/main or stale origin/HEAD', () => {
    const runtime = host();
    createWorktree({ target: 'exp/network-sources' }, root, runtime);
    expect(runtime.git).toHaveBeenCalledWith(['ls-remote', '--symref', 'origin', 'HEAD']);
    expect(runtime.git).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--end-of-options',
      'origin/trunk^{commit}',
    ]);
  });

  it('checks out an existing local branch without fetching its contents or rebasing', () => {
    const runtime = host(true);
    createWorktree({ target: 'exp/network-sources' }, root, runtime);
    expect(runtime.git).toHaveBeenCalledWith([
      'worktree',
      'add',
      destination,
      'exp/network-sources',
    ]);
    expect(runtime.git.mock.calls.some(([args]) => ['rebase', 'fetch'].includes(args[0]!))).toBe(
      false,
    );
  });

  it('rejects --base for existing branches rather than silently ignoring or resetting it', () => {
    const runtime = host(true);
    expect(() =>
      createWorktree({ target: 'exp/network-sources', base: 'main' }, root, runtime),
    ).toThrow(/existing branch/);
    expect(runtime.git.mock.calls.some(([args]) => args[0] === 'worktree')).toBe(false);
  });

  it('refuses to remove or alter an existing destination, including an existing PR path', () => {
    for (const target of ['exp/network-sources', '3837']) {
      const runtime = host();
      runtime.pathExists.mockReturnValue(true);
      expect(() => createWorktree({ target }, root, runtime)).toThrow(/already exists/);
      expect(runtime.git).not.toHaveBeenCalled();
      expect(runtime.gh).not.toHaveBeenCalled();
    }
  });

  it('fetches a PR without rebasing, and leaves an existing local PR branch untouched', () => {
    const runtime = host();
    createWorktree({ target: '3837' }, root, runtime);
    expect(runtime.git).toHaveBeenCalledWith([
      'fetch',
      'origin',
      'refs/heads/feature/source:refs/heads/pr-3837',
    ]);
    expect(runtime.git.mock.calls.some(([args]) => args[0] === 'rebase')).toBe(false);
    const existing = host(true);
    createWorktree({ target: '3837' }, root, existing);
    expect(existing.gh).not.toHaveBeenCalled();
    expect(existing.git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false);
  });

  it('passes refs as literal arguments instead of interpolating shell commands', () => {
    const runtime = host();
    createWorktree(
      { target: 'exp/network-sources', base: 'origin/topic;echo-pwned' },
      root,
      runtime,
    );
    expect(runtime.git).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      '--end-of-options',
      'origin/topic;echo-pwned^{commit}',
    ]);
  });
});

describe('generated directory containment', () => {
  it('accepts descendants and rejects the workspace root or paths outside it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readest-worktree-test-'));
    temporaryDirectories.push(directory);
    const inside = path.join(directory, 'gen', 'android');
    fs.mkdirSync(inside, { recursive: true });
    expect(() => assertContainedPath(directory, inside)).not.toThrow();
    expect(() => assertContainedPath(directory, directory)).toThrow();
    expect(() => assertContainedPath(directory, path.dirname(directory))).toThrow();
  });

  it('rejects a junction that would route Android cleanup outside the new worktree', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'readest-worktree-test-'));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, 'workspace');
    const external = path.join(directory, 'external');
    fs.mkdirSync(workspace);
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(workspace, 'gen'), 'junction');
    expect(() => assertContainedPath(workspace, path.join(workspace, 'gen', 'android'))).toThrow();
  });
});
