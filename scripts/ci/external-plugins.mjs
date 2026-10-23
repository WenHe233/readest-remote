import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
export const pin = JSON.parse(readFileSync(join(root, 'external-plugins.lock.json'), 'utf8'));
export const pluginDirectory = resolve(process.env.READEST_PLUGIN_SOURCE || join(root, '.external-plugins'));

function cli(name) {
  const candidates = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/);
  for (const candidate of candidates) {
    const actual = realpathSync(candidate);
    if (/\.(exe|mjs|cjs|js)$/.test(actual)) return actual;
    for (const extension of ['mjs', 'cjs', 'js']) {
      for (const base of [join(dirname(actual), 'node_modules', name), join(dirname(actual), '..', name), join(dirname(actual), '../lib/node_modules', name)]) {
        const file = join(base, 'bin', name === 'npm' ? 'npm-cli.js' : `${name}.${extension}`);
        if (existsSync(file)) return file;
      }
    }
  }
  throw new Error(`Cannot resolve ${name}'s executable`);
}
export function packageManagerCommand(name, { platform = process.platform, locate = cli } = {}) {
  // Unix supports direct execution of both shebang scripts and native binaries.
  // Only Windows needs to resolve .cmd shims to their Node entry point.
  if (platform !== 'win32') return [name];
  const file = locate(name);
  return file.endsWith('.exe') ? [file] : [process.execPath, file];
}
export function runPackageManager(name, args, cwd) {
  const [command, ...prefix] = packageManagerCommand(name);
  return execFileSync(command, [...prefix, ...args], { cwd, stdio: 'inherit' });
}
export async function preparePlugins() {
  if (!process.env.READEST_PLUGIN_SOURCE) {
    if (pin.repository !== 'WenHe233/readest-remote-plugins' || !/^[a-f0-9]{40}$/.test(pin.revision)) throw new Error('Invalid plugin source pin');
    mkdirSync(pluginDirectory, { recursive: true });
    const git = (...args) => execFileSync('git', args, { cwd: pluginDirectory, stdio: 'inherit' });
    if (!existsSync(join(pluginDirectory, '.git'))) {
      git('init'); git('remote', 'add', 'origin', `https://github.com/${pin.repository}.git`);
    }
    let current = '';
    try { current = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: pluginDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Newly initialized checkout. */ }
    if (current !== pin.revision) { git('fetch', '--depth=1', 'origin', pin.revision); git('checkout', '--detach', 'FETCH_HEAD'); }
  }
  const manifest = JSON.parse(readFileSync(join(pluginDirectory, 'package.json'), 'utf8'));
  if (manifest.name !== 'readest-remote-plugins') throw new Error('Unexpected plugin checkout');
  runPackageManager('npm', ['run', 'sdk:prepare', '--', '--local', join(root, 'packages/plugin-sdk')], pluginDirectory);
  runPackageManager('pnpm', ['install', '--frozen-lockfile'], pluginDirectory);
  return pluginDirectory;
}
