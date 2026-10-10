import { describe, expect, it } from 'vitest';
import { createPluginRangeFetcher } from '@/services/plugins/content';
import { reconcileExternalCatalog } from '@/services/plugins/library';
import { clearContentCache } from '@/services/plugins/cache';
import type { ConnectionLease } from '@/services/plugins/httpBroker';
import type { PluginConnection } from '@/services/plugins/types';
describe('persistent stream cache', () => {
  it('reuses aligned blocks on cold reopen, invalidates revisions, and never invents absent offline bytes', async () => {
    const connection: PluginConnection = {
      id: crypto.randomUUID(),
      pluginId: 'test.cache',
      fingerprint: 'a'.repeat(64),
      sourceId: 'test',
      name: 'Test',
      url: 'http://localhost',
      config: {},
      libraryIds: ['1'],
      secretNames: [],
      addedAt: 1,
      updatedAt: 1,
    };
    const [book] = reconcileExternalCatalog(
      connection,
      [
        {
          id: '1',
          libraryId: '1',
          title: 'Test',
          author: '',
          format: 'EPUB',
          revision: 'first',
          size: 524288,
        },
      ],
      [],
    );
    let calls = 0;
    let offline = false;
    const lease: ConnectionLease = {
      context: { sourceId: 'test', connection: 'handle', config: {}, secrets: {} },
      close() {},
      handleHostCall: async () => null,
      async request(input) {
        calls++;
        if (offline) throw new Error('Offline');
        const match = new Headers(input.headers).get('range')!.match(/bytes=(\d+)-(\d+)/)!;
        const start = Number(match[1]),
          end = Number(match[2]);
        return new Response(new Uint8Array(end - start + 1).fill(7), {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/524288` },
        });
      },
    };
    const descriptor = { kind: 'remote-file' as const, resource: { path: '/file' }, size: 524288 };
    await clearContentCache(book!.hash);
    const initial = createPluginRangeFetcher(book!, descriptor, lease);
    expect(
      (await (await initial('ignored', { headers: { Range: 'bytes=5-9' } })).arrayBuffer())
        .byteLength,
    ).toBe(5);
    expect(calls).toBe(1);
    offline = true;
    const reopened = createPluginRangeFetcher(book!, descriptor, lease);
    await reopened('ignored', { headers: { Range: 'bytes=7-11' } });
    expect(calls).toBe(1);
    await expect(
      reopened('ignored', { headers: { Range: 'bytes=200000-200009' } }),
    ).rejects.toThrow('Offline');
    const revised = {
      ...book!,
      externalSource: {
        ...book!.externalSource!,
        item: { ...book!.externalSource!.item, revision: 'second' },
      },
    };
    await expect(
      createPluginRangeFetcher(
        revised,
        descriptor,
        lease,
      )('ignored', { headers: { Range: 'bytes=7-11' } }),
    ).rejects.toThrow('Offline');
    await clearContentCache(book!.hash);
  });
});
