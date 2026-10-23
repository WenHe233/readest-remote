import {
  sourceHttpRequestSchema,
  type Json,
  type SourceContext,
  type SourceHttpResponse,
} from './content';
import { createContentHost } from './plugin';
import { PluginError, type PluginWorkerOperationContext } from './worker';

export interface HttpFixture {
  url: string;
  method?: string;
  response: Omit<SourceHttpResponse, 'url'> & { url?: string };
}

/** Deterministic HTTP replay. Unexpected requests fail; this helper never accesses the network. */
export function createHttpReplay(fixtures: HttpFixture[]) {
  const pending = [...fixtures];
  return {
    async request(input: unknown): Promise<SourceHttpResponse> {
      const request = sourceHttpRequestSchema.parse(input);
      const index = pending.findIndex(
        (fixture) =>
          fixture.url === request.url && (fixture.method ?? 'GET') === (request.method ?? 'GET'),
      );
      if (index < 0)
        throw new Error(`No HTTP fixture for ${request.method ?? 'GET'} ${request.url}`);
      const fixture = pending.splice(index, 1)[0]!;
      return {
        ...fixture.response,
        url: fixture.response.url ?? fixture.url,
        bytes: new Uint8Array(fixture.response.bytes),
      };
    },
    assertComplete() {
      if (pending.length) throw new Error(`${pending.length} HTTP fixtures were not consumed`);
    },
  };
}

/** In-memory scoped services for independent plugin contract tests. Not a production sandbox. */
export function createContentTestHost(
  source: SourceContext,
  fixtures: HttpFixture[] = [],
  settings: { source?: Record<string, Json>; plugin?: Record<string, Json> } = {},
) {
  const replay = createHttpReplay(fixtures);
  const controller = new AbortController();
  const storage = new Map<string, Json>();
  const cookies = new Map<string, string>();
  const progress: { stage: string; completed: number; total?: number }[] = [];
  const worker: PluginWorkerOperationContext = {
    signal: controller.signal,
    progress: (stage, completed, total) => {
      progress.push({ stage, completed, total });
    },
    async call(capability, payload) {
      controller.signal.throwIfAborted();
      if (!('instance' in payload) || payload.instance !== source.instance)
        throw new PluginError('Instance lease does not match the operation', 'PERMISSION_DENIED');
      if (capability === 'source.http') return replay.request(payload);
      if (capability === 'source.settings.read' && 'keys' in payload)
        return {
          values: Object.fromEntries(
            payload.keys
              .filter((key) => Object.hasOwn(settings[payload.scope ?? 'source'] ?? {}, key))
              .map((key) => [key, settings[payload.scope ?? 'source']![key]]),
          ),
        };
      if (capability === 'source.storage.get' && 'key' in payload)
        return storage.get(payload.key) ?? null;
      if (capability === 'source.storage.set' && 'key' in payload && 'value' in payload) {
        storage.set(payload.key, payload.value);
        return { saved: true };
      }
      if (capability === 'source.storage.delete' && 'key' in payload) {
        storage.delete(payload.key);
        return { deleted: true };
      }
      if (capability === 'source.cookies.get' && 'url' in payload)
        return { cookie: cookies.get(payload.url) ?? '' };
      if (capability === 'source.cookies.set' && 'url' in payload && 'cookie' in payload) {
        cookies.set(payload.url, payload.cookie);
        return { saved: true };
      }
      throw new PluginError(
        `Mock capability is unavailable: ${capability}`,
        'OPERATION_UNAVAILABLE',
      );
    },
  };
  return {
    host: createContentHost(source, worker),
    controller,
    progress,
    assertComplete: replay.assertComplete,
  };
}
