import { beforeEach, expect, it, vi } from 'vitest';
const records = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/services/plugins/persistence', () => ({
  listPluginRecords: async (prefix: string) =>
    [...records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value })),
  writePluginRecords: async (values: Record<string, unknown>, removed: string[] = []) => {
    Object.entries(values).forEach(([key, value]) => records.set(key, value));
    removed.forEach((key) => records.delete(key));
  },
}));
beforeEach(() => {
  vi.resetModules();
  records.clear();
});
it('persists list snapshots, deduplicates URLs and retains a snapshot on refresh failure', async () => {
  const service = await import('@/services/contentSources/subscriptions');
  const owner = {
    pluginId: 'example.compat',
    fingerprint: 'a'.repeat(64),
    providerId: 'native',
    format: 'list',
    name: 'My sources',
    url: 'https://example.com/index.json',
  };
  const item = await service.saveSourceSubscription(owner, [
    { name: 'One', url: 'https://example.com/one.js', format: 'native' },
    { name: 'One', url: 'https://example.com/one.js', format: 'native' },
  ]);
  expect(item.references).toHaveLength(1);
  await service.saveSourceSubscription({ ...owner, name: 'Renamed' }, item.references);
  vi.resetModules();
  const restored = await import('@/services/contentSources/subscriptions');
  await restored.loadSourceSubscriptions();
  expect(restored.useSourceSubscriptions.getState().subscriptions).toHaveLength(1);
  const saved = restored.useSourceSubscriptions.getState().subscriptions[0]!;
  await expect(
    restored.refreshSourceSubscription(saved.id, async () => {
      throw new Error('Offline');
    }),
  ).rejects.toThrow('Offline');
  expect(restored.useSourceSubscriptions.getState().subscriptions[0]?.references).toEqual(
    item.references,
  );
});
