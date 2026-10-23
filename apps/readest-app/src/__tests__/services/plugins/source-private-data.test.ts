import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceInstance } from '@/services/contentSources/instances';
const memory = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  vault: new Map<string, Record<string, string>>(),
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/services/plugins/persistence', () => ({
  readPluginRecord: async (key: string) => memory.records.get(key),
  listPluginRecords: async (prefix: string) =>
    [...memory.records]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  writePluginRecords: async (values: Record<string, unknown>, removed: string[] = []) => {
    Object.entries(values).forEach(([key, value]) => memory.records.set(key, value));
    removed.forEach((key) => memory.records.delete(key));
  },
}));
vi.mock('@/services/plugins/vault', () => ({
  getConnectionSecrets: async (key: string) => memory.vault.get(key) ?? {},
  setConnectionSecrets: async (key: string, value: Record<string, string>) => {
    memory.vault.set(key, value);
  },
  clearConnectionSecrets: async (key: string) => {
    memory.vault.delete(key);
  },
}));
const source = (id: string, pluginId = 'test.source'): SourceInstance => ({
  id,
  pluginId,
  fingerprint: 'a'.repeat(64),
  providerId: 'native',
  name: 'Source',
  config: { choice: 'keep' },
  enabled: true,
  origins: ['https://books.example'],
  allowPrivateNetwork: false,
  secretNames: [],
  createdAt: 1,
  updatedAt: 1,
});
beforeEach(() => {
  vi.resetModules();
  memory.records.clear();
  memory.vault.clear();
});

describe('source private data clearing', () => {
  it('erases secrets, encrypted state and cookies but keeps definitions, downloaded chapters and other plugins', async () => {
    const { saveSourceInstance, clearSourcePluginData, getSourceInstance } = await import(
      '@/services/contentSources/instances'
    );
    const { sourcePrivateScope, writeSourcePrivateValue, readSourceCredentials } = await import(
      '@/services/contentSources/privateStorage'
    );
    const a = await saveSourceInstance(source('00000000-0000-4000-8000-000000000001'), {
      secrets: { token: 'very-secret'.repeat(800) },
      definition: { id: 'rule', format: 'native', name: 'Rule', content: '{}', revision: '1' },
    });
    const b = await saveSourceInstance(
      source('00000000-0000-4000-8000-000000000002', 'other.plugin'),
      { secrets: { token: 'other-secret' } },
    );
    for (const kind of ['kv', 'cookie'] as const) {
      const scope = sourcePrivateScope(kind, a);
      await writeSourcePrivateValue(scope, scope + 'state', { secret: 'cookie-secret' });
    }
    memory.records.set('source-download:book:chapter', {
      completedAt: 1,
      content: 'offline-content',
    });
    expect([...memory.vault.values()].every((value) => JSON.stringify(value).length < 2048)).toBe(
      true,
    );
    expect(JSON.stringify([...memory.records.values()])).not.toContain('very-secret');
    await clearSourcePluginData(a.pluginId, a.fingerprint);
    expect(getSourceInstance(a.id)?.secretNames).toEqual([]);
    expect(getSourceInstance(a.id)?.config).toEqual({ choice: 'keep' });
    expect(memory.records.has(`source-definition:${a.definitionId}`)).toBe(true);
    expect(memory.records.has('source-download:book:chapter')).toBe(true);
    expect(
      [...memory.records.keys()].some((key) =>
        /source-(kv|cookie|credentials):test.source:/.test(key),
      ),
    ).toBe(false);
    expect(await readSourceCredentials(b)).toEqual({ token: 'other-secret' });
    await saveSourceInstance(getSourceInstance(a.id)!, { secrets: { token: 'new-secret' } });
    expect(await readSourceCredentials(getSourceInstance(a.id)!)).toEqual({ token: 'new-secret' });
  });
});
