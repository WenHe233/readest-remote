import { describe, expect, it, vi } from 'vitest';
import { createContentTestHost } from '@readest/plugin-sdk/testing';
import {
  defineContentProvider,
  definePlugin,
  pluginManifestSchema,
  pluginRequestSchema,
  parsePluginOperationResult,
  sourceContextSchema,
  type PluginWorkerGlobalLike,
} from '@readest/plugin-sdk';

const context = { instance: 'opaque-lease', providerId: 'native', config: {} };
const work = { id: 'work-1', title: 'Example', author: 'Author', kind: 'text' as const };
const chapter = { id: 'chapter-1', title: 'First chapter' };
const manifest = {
  id: 'example.native',
  protocolVersion: 2 as const,
  pluginVersion: '1.0.0',
  pluginApi: { min: 3, max: 3 },
  contributions: {
    dictionaryFormats: [],
    contentSources: [
      {
        id: 'native',
        name: 'Native',
        kinds: ['text' as const],
        settings: [],
        capabilities: { search: true },
      },
    ],
  },
};

class WorkerScope implements PluginWorkerGlobalLike {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  sent: unknown[] = [];
  postMessage(message: unknown) {
    this.sent.push(message);
  }
  emit(data: unknown) {
    this.onmessage?.(new MessageEvent('message', { data }));
  }
}

describe('API 3 content contracts', () => {
  it('accepts reviewable source-list references and rejects non-network reference URLs', () => {
    const result = {
      definitions: [],
      references: [
        { name: 'Example source', url: 'https://example.com/source.js', format: 'venera' },
      ],
    };
    expect(parsePluginOperationResult('source.inspect', result)).toEqual(result);
    expect(() =>
      parsePluginOperationResult('source.inspect', {
        ...result,
        references: [{ ...result.references[0], url: 'file:///source.js' }],
      }),
    ).toThrow();
    expect(
      pluginRequestSchema.parse({
        kind: 'request',
        protocolVersion: 2,
        requestId: 'list',
        operation: 'source.inspect',
        payload: {
          context,
          content: '{}',
          format: 'venera',
          baseUrl: 'https://example.com/list.json',
        },
      }).operation,
    ).toBe('source.inspect');
  });
  it('replays HTTP deterministically and isolates mock instance state', async () => {
    const first = createContentTestHost(context, [
      {
        url: 'https://example.com/chapter',
        response: { status: 200, headers: {}, bytes: new TextEncoder().encode('chapter') },
      },
    ]);
    const second = createContentTestHost({ ...context, instance: 'another-lease' });
    await first.host.storage.set('login', { name: 'fixture' });
    expect(await second.host.storage.get('login')).toBeNull();
    expect(() => first.assertComplete()).toThrow(/not consumed/);
    const response = await first.host.http({ url: 'https://example.com/chapter' });
    expect(new TextDecoder().decode(response.bytes)).toBe('chapter');
    first.assertComplete();
    await expect(first.host.http({ url: 'https://example.com/unexpected' })).rejects.toThrow(
      /No HTTP fixture/,
    );
    first.controller.abort();
    await expect(first.host.storage.get('login')).rejects.toThrow();
  });
  it('keeps RPC 2 and accepts native instances with no URL or source definition', () => {
    expect(sourceContextSchema.parse(context)).toEqual(context);
    expect(pluginManifestSchema.parse(manifest).protocolVersion).toBe(2);
    expect(
      pluginRequestSchema.parse({
        kind: 'request',
        protocolVersion: 2,
        requestId: '1',
        operation: 'source.search',
        payload: { context, query: 'Example' },
      }).operation,
    ).toBe('source.search');
  });

  it('requires API 3 for new contributions and rejects unknown operations and invalid content', () => {
    expect(() =>
      pluginManifestSchema.parse({ ...manifest, pluginApi: { min: 2, max: 2 } }),
    ).toThrow();
    expect(() =>
      pluginRequestSchema.parse({
        kind: 'request',
        protocolVersion: 2,
        requestId: '1',
        operation: 'source.eval',
        payload: { context },
      }),
    ).toThrow();
    expect(() =>
      parsePluginOperationResult('source.resolveChapter', {
        kind: 'pages',
        pages: [{ url: 'file:///secret' }],
      }),
    ).toThrow();
    expect(() =>
      parsePluginOperationResult('source.resolveChapter', {
        kind: 'html',
        html: '<p>ok</p>',
        script: 'evil',
      }),
    ).toThrow();
  });

  it('dispatches a native provider and binds HTTP to the host-provided instance', async () => {
    const scope = new WorkerScope();
    const provider = defineContentProvider({
      id: 'native',
      search: async (_input, host) => {
        await host.http({ url: 'https://example.com/search' });
        return { items: [work] };
      },
      getWork: async () => work,
      getChapters: async () => ({ items: [chapter] }),
      resolveChapter: async () => ({ kind: 'html', html: '<p>Hello</p>' }),
      resolveResource: async ({ resource }) => ({ url: resource.url! }),
    });
    definePlugin({ manifest, contentProviders: [provider] }).start(scope);
    scope.emit({
      kind: 'request',
      protocolVersion: 2,
      requestId: '1',
      operation: 'source.search',
      payload: { context, query: 'test' },
    });
    await vi.waitFor(() => expect(scope.sent).toHaveLength(1));
    expect(scope.sent[0]).toMatchObject({
      capability: 'source.http',
      payload: { instance: context.instance, url: 'https://example.com/search' },
    });
    const callId = (scope.sent[0] as { callId: string }).callId;
    scope.emit({
      kind: 'host-result',
      protocolVersion: 2,
      requestId: '1',
      callId,
      ok: true,
      result: {
        status: 200,
        url: 'https://example.com/search',
        headers: {},
        bytes: new Uint8Array(),
      },
    });
    await vi.waitFor(() => expect(scope.sent).toHaveLength(2));
    expect(scope.sent[1]).toMatchObject({ ok: true, result: { items: [work] } });
  });

  it('returns a structured unavailable error for optional operations instead of throwing outside the worker', async () => {
    const scope = new WorkerScope();
    definePlugin({
      manifest: {
        ...manifest,
        contributions: {
          ...manifest.contributions,
          contentSources: [{ ...manifest.contributions.contentSources[0]!, capabilities: {} }],
        },
      },
      contentProviders: [
        defineContentProvider({
          id: 'native',
          getWork: async () => work,
          getChapters: async () => ({ items: [] }),
          resolveChapter: async () => ({ kind: 'html', html: '' }),
          resolveResource: async () => ({ url: 'https://example.com/resource' }),
        }),
      ],
    }).start(scope);
    expect(() =>
      scope.emit({
        kind: 'request',
        protocolVersion: 2,
        requestId: '1',
        operation: 'source.explore',
        payload: { context },
      }),
    ).not.toThrow();
    await vi.waitFor(() => expect(scope.sent).toHaveLength(1));
    expect(scope.sent[0]).toMatchObject({ ok: false, error: { code: 'OPERATION_UNAVAILABLE' } });
  });
});
