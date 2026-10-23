import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceInstance } from '@/services/contentSources/instances';
import { createSourceLease, type SourceTransport } from '@/services/contentSources/network';
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => false }));
const memory = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  vault: new Map<string, Record<string, string>>(),
}));
vi.mock('@/services/plugins/persistence', () => ({
  readPluginRecord: async (key: string) => memory.records.get(key),
  listPluginRecords: async (prefix: string) =>
    [...memory.records]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value })),
  writePluginRecords: async (values: Record<string, unknown>, remove: string[] = []) => {
    Object.entries(values).forEach(([key, value]) => memory.records.set(key, value));
    remove.forEach((key) => memory.records.delete(key));
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
const instance = (id = 'source-a'): SourceInstance => ({
  id,
  pluginId: 'test.source',
  providerId: 'native',
  fingerprint: 'a'.repeat(64),
  name: 'Source',
  enabled: true,
  config: {},
  origins: ['https://books.example', 'https://cdn.example'],
  allowPrivateNetwork: false,
  secretNames: ['token'],
  createdAt: 1,
  updatedAt: 1,
});
const reply = (
  url = 'https://books.example',
  status = 200,
  headers: Record<string, string> = {},
  setCookies: string[] = [],
) => ({ url, status, headers, setCookies, bytes: new TextEncoder().encode('body') });
beforeEach(() => {
  memory.records.clear();
  memory.vault.clear();
});

describe('source host network boundary', () => {
  it('keeps large cookie jars out of platform credential records', async () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `cookie${i}=${'x'.repeat(200)}; Path=/; Secure`,
    );
    const lease = createSourceLease(
      instance(),
      { network: true, cookies: true },
      () => true,
      undefined,
      async (url) => reply(url, 200, {}, lines),
    );
    await lease.request({ instance: lease.context.instance, url: 'https://books.example' });
    expect([...memory.vault.values()].every((value) => JSON.stringify(value).length < 2048)).toBe(
      true,
    );
    expect([...memory.records.keys()].some((key) => key.startsWith('source-cookie:'))).toBe(true);
  });
  it('counts direct resource requests as busy and does not expose a query-bound secret', async () => {
    memory.vault.set('source:source-a', { token: 'private-key' });
    let finish: (() => void) | undefined;
    const transport: SourceTransport = async (url) => {
      expect(new URL(url).searchParams.get('token')).toBe('private-key');
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return reply(url);
    };
    const lease = createSourceLease(
      instance(),
      { network: true, secrets: true },
      () => true,
      undefined,
      transport,
    );
    const request = lease.request({
      instance: lease.context.instance,
      url: 'https://books.example/read',
      auth: [{ secret: lease.context.secrets!['token']!, in: 'query', name: 'token' }],
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(lease.busy()).toBe(true);
    finish!();
    expect((await request).url).not.toContain('private-key');
    expect(lease.busy()).toBe(false);
  });
  it('checks each redirect and strips credentials before a different granted origin', async () => {
    memory.vault.set('source:source-a', { token: 'private-key' });
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const transport: SourceTransport = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return calls.length === 1
        ? reply(url, 302, { location: 'https://cdn.example/image' }, [
            'sid=session; Path=/; Secure',
          ])
        : reply(url);
    };
    const lease = createSourceLease(
      instance(),
      { network: true, secrets: true, cookies: true },
      () => true,
      undefined,
      transport,
    );
    await lease.request({
      instance: lease.context.instance,
      url: 'https://books.example/read',
      auth: [{ secret: lease.context.secrets!['token']!, in: 'header', name: 'authorization' }],
    });
    expect(calls[0]!.headers['authorization']).toBe('private-key');
    expect(calls[1]!.headers).not.toHaveProperty('authorization');
    expect(calls[1]!.headers).not.toHaveProperty('cookie');
    expect([...memory.records.keys()].some((key) => key.startsWith('source-cookie:'))).toBe(true);
  });
  it('rejects a redirect to a domain that has not been granted before contacting it', async () => {
    const transport = vi.fn<SourceTransport>(async (url) =>
      reply(url, 302, { location: 'https://evil.example/private' }),
    );
    const lease = createSourceLease(
      instance(),
      { network: true },
      () => true,
      undefined,
      transport,
    );
    await expect(
      lease.request({ instance: lease.context.instance, url: 'https://books.example' }),
    ).rejects.toMatchObject({ code: 'SOURCE_ORIGIN_REQUIRED' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('binds host calls to the invoking request and keeps storage separate for each instance', async () => {
    const a = createSourceLease(instance(), { storage: true }, () => true);
    const b = createSourceLease(instance('source-b'), { storage: true }, () => true);
    const signal = new AbortController().signal;
    const owner = {
      kind: 'request' as const,
      protocolVersion: 2 as const,
      requestId: 'r',
      operation: 'source.search' as const,
      payload: { context: a.context, query: 'test' },
    };
    const call = {
      kind: 'host-call' as const,
      protocolVersion: 2 as const,
      requestId: 'r',
      callId: 'c',
      capability: 'source.storage.set' as const,
      payload: { instance: a.context.instance, key: 'state', value: 'first' },
    };
    await a.handleHostCall(call, owner, signal);
    expect(JSON.stringify([...memory.records.values()])).not.toContain('first');
    await expect(b.handleHostCall(call, owner, signal)).rejects.toMatchObject({
      code: 'SOURCE_PERMISSION_DENIED',
    });
    const read = {
      ...call,
      capability: 'source.storage.get' as const,
      payload: { instance: b.context.instance, key: 'state' },
    };
    expect(
      await b.handleHostCall(
        read,
        { ...owner, payload: { context: b.context, query: 'test' } },
        signal,
      ),
    ).toBeNull();
  });
  it('disallows network activity during import inspection and after revocation', async () => {
    const transport = vi.fn<SourceTransport>(async () => reply());
    const inspect = createSourceLease(
      instance(),
      { network: true },
      () => true,
      undefined,
      transport,
      true,
    );
    await expect(
      inspect.request({ instance: inspect.context.instance, url: 'https://books.example' }),
    ).rejects.toThrow(/no network permission/);
    let enabled = true;
    const lease = createSourceLease(
      instance(),
      { network: true },
      () => enabled,
      undefined,
      transport,
    );
    enabled = false;
    await expect(
      lease.request({ instance: lease.context.instance, url: 'https://books.example' }),
    ).rejects.toThrow(/revoked/);
    expect(transport).not.toHaveBeenCalled();
  });
});
