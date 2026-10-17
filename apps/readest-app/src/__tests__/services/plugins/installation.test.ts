import { describe, expect, it } from 'vitest';
import { getPluginInstallState } from '@/services/plugins/installation';

describe('plugin installation availability', () => {
  const candidate = { version: '0.1.1', fingerprint: 'signed', compatible: true };
  const installed = { version: '0.1.1', fingerprint: 'signed' };
  it('offers installation only when absent', () => {
    expect(getPluginInstallState(candidate)).toBe('install');
  });
  it.each([
    '0.1.1',
    '0.1.0',
    '0.1.1-beta.1',
    '0.1.1+rebuilt',
  ])('does not offer version %s over the installed version', (version) => {
    expect(getPluginInstallState({ ...candidate, version }, installed)).toBe('installed');
  });
  it.each(['0.1.2', '0.2.0-beta.1', '0.10.0'])('offers newer version %s', (version) => {
    expect(getPluginInstallState({ ...candidate, version }, installed)).toBe('update');
  });
  it('blocks incompatible versions and conflicting signers', () => {
    expect(getPluginInstallState({ ...candidate, compatible: false })).toBe('incompatible');
    expect(getPluginInstallState({ ...candidate, fingerprint: 'other' }, installed)).toBe(
      'conflict',
    );
    expect(getPluginInstallState({ ...candidate, conflict: true })).toBe('conflict');
  });
  it('re-evaluates a candidate after another installation finishes', () => {
    const release = { ...candidate, version: '0.2.0' };
    expect(getPluginInstallState(release, installed)).toBe('update');
    expect(getPluginInstallState(release, release)).toBe('installed');
  });
});
