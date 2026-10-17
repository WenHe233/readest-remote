import { gt } from 'semver';

interface PluginVersion {
  version: string;
  fingerprint: string;
}

export function getPluginInstallState(
  candidate: PluginVersion & { compatible?: boolean; conflict?: boolean },
  installed?: PluginVersion,
): 'install' | 'update' | 'installed' | 'conflict' | 'incompatible' {
  if (candidate.conflict || (installed && installed.fingerprint !== candidate.fingerprint))
    return 'conflict';
  if (candidate.compatible === false) return 'incompatible';
  if (!installed) return 'install';
  return gt(candidate.version, installed.version) ? 'update' : 'installed';
}
