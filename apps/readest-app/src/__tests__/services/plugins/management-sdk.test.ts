import { describe, expect, it } from 'vitest';
import {
  anySignal,
  normalizePluginErrorPayload,
  pluginResponseSchema,
  pluginManifestSchema,
  pluginRequestSchema,
  parsePluginOperationResult,
  supportsPluginApi,
} from '@readest/plugin-sdk';

describe('API 4 management contracts', () => {
  it('supports API 2/3 and declares scoped management pages only on API 4', () => {
    expect(supportsPluginApi({ min: 4, max: 4 })).toBe(true);
    expect(supportsPluginApi({ min: 2, max: 2 })).toBe(true);
    expect(supportsPluginApi({ min: 3, max: 3 })).toBe(true);
    const manifest = {
      id: 'example.native',
      protocolVersion: 2,
      pluginVersion: '1',
      pluginApi: { min: 4, max: 4 },
      contributions: {
        contentSources: [
          {
            id: 'native',
            name: 'Native',
            kinds: ['comic'],
            settings: [],
            capabilities: { describe: true },
          },
        ],
        managementPages: [
          {
            id: 'manage',
            title: 'Manage',
            providerIds: ['native'],
            sections: ['sourceInstances', 'sourceSubscriptions', 'settings', 'information'],
          },
        ],
      },
    };
    expect(pluginManifestSchema.parse(manifest).contributions.managementPages).toHaveLength(1);
    expect(() =>
      pluginManifestSchema.parse({ ...manifest, pluginApi: { min: 3, max: 3 } }),
    ).toThrow();
    expect(() =>
      pluginManifestSchema.parse({
        ...manifest,
        contributions: {
          ...manifest.contributions,
          managementPages: [
            { ...manifest.contributions.managementPages[0], providerIds: ['other'] },
          ],
        },
      }),
    ).toThrow();
  });
  it('validates dynamic settings and rejects arbitrary setting actions', () => {
    const result = {
      settings: [
        { key: 'apiKey', label: 'API Key', type: 'secret', default: '' },
        {
          key: 'language',
          label: 'Language',
          type: 'select',
          options: [{ value: 'en', label: 'English' }],
          default: 'en',
        },
      ],
      actions: [{ id: 'clear', label: 'Clear session' }],
      authentication: { kind: 'unsupported', reason: 'account.loginWithWebview' },
    };
    expect(parsePluginOperationResult('source.describe', result)).toEqual(result);
    expect(() =>
      parsePluginOperationResult('source.describe', {
        ...result,
        settings: [{ key: 'x', type: 'html', label: 'Unsafe' }],
      }),
    ).toThrow();
    expect(
      pluginRequestSchema.parse({
        kind: 'request',
        protocolVersion: 2,
        requestId: 'r',
        operation: 'source.runSettingAction',
        payload: {
          context: { instance: 'lease', providerId: 'native', config: {} },
          actionId: 'clear',
        },
      }).operation,
    ).toBe('source.runSettingAction');
  });
  it('transports only bounded diagnostic metadata', () => {
    const diagnostic = { stage: 'tls', status: 503, retryable: true };
    const error = normalizePluginErrorPayload('SOURCE_HTTP_TLS_FAILED', 'Safe message', diagnostic);
    expect(error.diagnostic).toEqual(diagnostic);
    expect(
      normalizePluginErrorPayload('FAILED', 'Safe', {
        ...diagnostic,
        url: 'https://secret.example/?token=value',
      }).diagnostic,
    ).toBeUndefined();
    expect(() =>
      pluginResponseSchema.parse({
        kind: 'response',
        protocolVersion: 2,
        requestId: 'r',
        ok: false,
        error: { ...error, diagnostic: { status: 999 } },
      }),
    ).toThrow();
  });
  it('provides cancellation without AbortSignal.any and removes listeners', () => {
    const first = new AbortController();
    const second = new AbortController();
    const combined = anySignal(first.signal, second.signal);
    second.abort('stop');
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBe('stop');
    combined.cleanup();
  });
});
