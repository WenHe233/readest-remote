import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConnectionLease } from '@/services/plugins/httpBroker';
import { KIND_ALLOWLIST } from '@/libs/replicaSchemas';
import { pluginConnectionSchema } from '@/services/plugins/types';
const fixture = vi.hoisted(() => ({
  connection: {
    id: '11111111-1111-4111-8111-111111111111',
    pluginId: 'test.library',
    fingerprint: 'a'.repeat(64),
    sourceId: 'library',
    name: 'Books',
    url: 'https://server.example/kavita',
    config: {},
    libraryIds: ['1'],
    secretNames: ['apiKey'],
    addedAt: 1,
    updatedAt: 1,
  },
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
vi.mock('@/services/plugins/connections', () => ({
  getPluginConnection: () => fixture.connection,
  getPluginDeviceConfig: async () => ({}),
}));
vi.mock('@/services/plugins/vault', () => ({
  getConnectionSecrets: async () => ({ apiKey: 'private-test-key' }),
}));
afterEach(() => vi.unstubAllGlobals());
describe('external plugin authorization', () => {
  it('injects opaque secrets only into the configured server request', async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    const lease = createConnectionLease(
      fixture.connection,
      { network: true, secrets: true },
      () => true,
    );
    expect(lease.context.secrets['apiKey']).not.toBe('private-test-key');
    await lease.request({
      connection: lease.context.connection,
      path: '/api/books',
      auth: [{ secret: lease.context.secrets['apiKey']!, in: 'header', name: 'X-API-Key' }],
    });
    expect((fetcher.mock.calls as unknown as [string, RequestInit][])[0]?.[0]).toBe(
      'https://server.example/kavita/api/books',
    );
    const init = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]![1];
    expect(new Headers(init.headers).get('X-API-Key')).toBe('private-test-key');
    await expect(
      lease.request({ connection: 'another-connection', path: '/api/books' }),
    ).rejects.toThrow();
    lease.close();
  });
  it('rejects redirect escapes from the configured base path', async () => {
    const fetcher = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: '/admin' } }),
    );
    vi.stubGlobal('fetch', fetcher);
    const lease = createConnectionLease(fixture.connection, { network: true }, () => true);
    await expect(
      lease.request({ connection: lease.context.connection, path: '/api/books' }),
    ).rejects.toThrow(/redirect/i);
    expect(fetcher).toHaveBeenCalledTimes(1);
    lease.close();
  });
  it('does not allow secret bindings to bypass restricted-header checks', async () => {
    const fetcher = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', fetcher);
    const lease = createConnectionLease(
      fixture.connection,
      { network: true, secrets: true },
      () => true,
    );
    await expect(
      lease.request({
        connection: lease.context.connection,
        path: '/api/books',
        auth: [{ secret: lease.context.secrets['apiKey']!, in: 'header', name: 'Host' }],
      }),
    ).rejects.toThrow(/header/i);
    expect(fetcher).not.toHaveBeenCalled();
    lease.close();
  });
  it('accepts encrypted credential envelopes and rejects plaintext at the server', () => {
    const fields = KIND_ALLOWLIST['plugin_connection']!.fields;
    expect(fields.safeParse({ credentials: { v: 'secret', t: '1', s: 'device' } }).success).toBe(
      false,
    );
    expect(
      fields.safeParse({
        credentials: {
          v: { c: 'cipher', i: 'nonce', s: 'salt', alg: 'AES-GCM', h: 'hash' },
          t: '1',
          s: 'device',
        },
      }).success,
    ).toBe(true);
    expect(fields.safeParse({ enabled: { v: true, t: '1', s: 'device' } }).success).toBe(false);
  });
  it('rejects server addresses containing credentials, queries or non-HTTP protocols', () => {
    for (const url of [
      'file:///tmp/book',
      'https://u:p@server.example',
      'https://server.example?key=secret',
    ])
      expect(pluginConnectionSchema.safeParse({ ...fixture.connection, url }).success).toBe(false);
  });
});
