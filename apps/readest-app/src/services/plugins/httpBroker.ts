import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { isTauriAppPlatform } from '@/services/environment';
import { anySignal } from '@/utils/abort';
import type {
  HttpRequest,
  HttpResponse,
  LibraryContext,
  PluginPermissions,
} from '@readest/plugin-sdk';
import { getPluginConnection, getPluginDeviceConfig } from './connections';
import type { PluginConnection, PluginDeviceConfig } from './types';
import { getConnectionSecrets } from './vault';
import { listPluginRecords, readPluginRecord, writePluginRecords } from './persistence';
import type { PluginHostCallHandler } from './runtime';

export function resolvePluginUrl(base: string, path: string): URL {
  const root = new URL(base);
  if (
    !['http:', 'https:'].includes(root.protocol) ||
    root.username ||
    root.password ||
    root.search ||
    root.hash
  )
    throw new Error('Invalid server URL');
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/u.test(path))
    throw new Error('Invalid resource path');
  let decoded = path;
  for (let i = 0; i < 3; i++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (
    decoded.startsWith('//') ||
    decoded.includes('\\') ||
    decoded.split('/').some((p) => p === '..' || p === '.')
  )
    throw new Error('Resource path escapes connection');
  const url = new URL(root.href.replace(/\/+$/u, '') + path);
  if (url.origin !== root.origin) throw new Error('Resource origin is not permitted');
  return url;
}
const storageWrites = new Map<string, Promise<unknown>>();
const RESPONSE_LIMIT = 32 * 1024 * 1024;
export interface ConnectionLease {
  context: LibraryContext;
  request(input: HttpRequest, signal?: AbortSignal, timeoutMs?: number): Promise<Response>;
  handleHostCall: PluginHostCallHandler;
  close(): void;
}
interface ConnectionAccess {
  connection: () => PluginConnection | undefined;
  device: () => Promise<PluginDeviceConfig>;
  credentials: () => Promise<Record<string, string>>;
}
export function createConnectionLease(
  connection: PluginConnection,
  permissions: PluginPermissions,
  stillAllowed: () => boolean,
  draft?: ConnectionAccess,
): ConnectionLease {
  const controller = new AbortController();
  const slots = new Map<string, string>();
  const context: LibraryContext = {
    sourceId: connection.sourceId,
    connection: crypto.randomUUID(),
    config: connection.config,
    secrets: {},
  };
  for (const name of connection.secretNames) {
    const token = crypto.randomUUID();
    slots.set(token, name);
    context.secrets[name] = token;
  }
  const request = async (
    input: HttpRequest,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<Response> => {
    const live = draft ? draft.connection() : getPluginConnection(connection.id);
    if (
      !stillAllowed() ||
      !permissions.network ||
      !live ||
      live.fingerprint !== connection.fingerprint ||
      live.pluginId !== connection.pluginId ||
      input.connection !== context.connection
    )
      throw new Error('Plugin connection permission denied');
    controller.signal.throwIfAborted();
    signal?.throwIfAborted();
    const device = await (draft ? draft.device() : getPluginDeviceConfig(connection.id));
    const root = device.urlOverride || live.url;
    let url = resolvePluginUrl(root, input.path);
    for (const [name, value] of Object.entries(input.query ?? {}))
      url.searchParams.set(name, String(value));
    const headers = new Headers(input.headers);
    const secrets = input.auth?.length
      ? await (draft ? draft.credentials() : getConnectionSecrets(live.id))
      : {};
    for (const binding of input.auth ?? []) {
      if (!permissions.secrets) throw new Error('Plugin secrets permission denied');
      const slot = slots.get(binding.secret);
      if (!slot || !(slot in secrets)) throw new Error('Connection credential is unavailable');
      if (binding.in === 'header') headers.set(binding.name, secrets[slot]!);
      else url.searchParams.set(binding.name, secrets[slot]!);
    }
    for (const forbidden of ['cookie', 'host', 'origin', 'referer', 'proxy-authorization'])
      if (headers.has(forbidden)) throw new Error('Restricted request header');
    const body = input.json === undefined ? undefined : JSON.stringify(input.json);
    if (body && body.length > 1024 * 1024) throw new Error('Request body exceeds limit');
    if (body) headers.set('Content-Type', 'application/json');
    // Keep cancellation connected while callers consume the response body.
    // anySignal detaches its listeners on deadline, cancellation or lease close.
    const abort = anySignal(controller.signal, AbortSignal.timeout(timeoutMs), signal);
    for (let hop = 0; hop < 6; hop++) {
      abort.signal.throwIfAborted();
      const init = {
        method: input.method ?? 'GET',
        headers,
        body,
        signal: abort.signal,
        redirect: 'manual' as const,
      };
      let response: Response;
      try {
        response = isTauriAppPlatform()
          ? await nativeFetch(url.href, {
              ...init,
              maxRedirections: 0,
              ...(device.allowInvalidTls
                ? { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true } }
                : {}),
            })
          : await fetch(url.href, { ...init, credentials: 'omit' });
      } catch (error) {
        if (signal?.aborted || controller.signal.aborted)
          throw new DOMException('Cancelled', 'AbortError');
        throw new Error('Unable to reach the configured server', {
          cause: error instanceof DOMException ? error : undefined,
        });
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Server redirect is unavailable');
      const target = new URL(location, url);
      const base = new URL(root);
      const prefix = base.pathname.replace(/\/+$/u, '');
      if (
        target.origin !== base.origin ||
        target.username ||
        target.password ||
        (prefix && target.pathname !== prefix && !target.pathname.startsWith(prefix + '/'))
      )
        throw new Error('Redirect outside the configured server is denied');
      // Validate encoded traversal and backslashes after the browser URL parser.
      resolvePluginUrl(base.origin, target.pathname);
      if (input.method && input.method !== 'GET' && input.method !== 'HEAD')
        throw new Error('Redirecting write requests is not permitted');
      url = target;
    }
    throw new Error('Too many server redirects');
  };
  const handleHostCall: PluginHostCallHandler = async (call, owner, signal) => {
    signal?.throwIfAborted();
    if (
      !stillAllowed() ||
      !('context' in owner.payload) ||
      !('connection' in owner.payload.context) ||
      owner.payload.context.connection !== context.connection
    )
      throw new Error('Plugin request scope denied');
    if (call.capability === 'http.request') {
      const response = await request(call.payload, signal);
      const bytes = await readBoundedBody(response, RESPONSE_LIMIT);
      const safeHeaders: Record<string, string> = {};
      for (const name of [
        'content-type',
        'content-length',
        'content-range',
        'etag',
        'last-modified',
        'pagination',
      ]) {
        const value = response.headers.get(name);
        if (value) safeHeaders[name] = value;
      }
      return { status: response.status, headers: safeHeaders, bytes } satisfies HttpResponse;
    }
    if (!permissions.storage || !call.capability.startsWith('storage.'))
      throw new Error('Plugin capability denied');
    const prefix = 'kv:' + connection.pluginId + ':' + connection.fingerprint + ':';
    if (call.capability === 'storage.get')
      return (await readPluginRecord(prefix + call.payload.key)) ?? null;
    if (call.capability === 'storage.delete' || call.capability === 'storage.set') {
      const operation = (storageWrites.get(prefix) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          signal?.throwIfAborted();
          if (!stillAllowed()) throw new Error('Plugin permission revoked');
          if (call.capability === 'storage.delete') {
            await writePluginRecords({}, [prefix + call.payload.key]);
            return null;
          }
          const encoded = JSON.stringify(call.payload.value);
          if (encoded.length > 65536) throw new Error('Storage value exceeds limit');
          const rows = await listPluginRecords(prefix);
          const size =
            rows
              .filter((r) => r.key !== prefix + call.payload.key)
              .reduce((n, r) => n + JSON.stringify(r.value).length, 0) + encoded.length;
          if (size > 2 * 1024 * 1024) throw new Error('Plugin storage quota exceeded');
          await writePluginRecords({ [prefix + call.payload.key]: call.payload.value });
          return null;
        });
      storageWrites.set(prefix, operation);
      try {
        return await operation;
      } finally {
        if (storageWrites.get(prefix) === operation) storageWrites.delete(prefix);
      }
    }
    throw new Error('Unsupported capability');
  };
  return { context, request, handleHostCall, close: () => controller.abort() };
}
export async function readBoundedBody(
  response: Response,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Response exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error('Response exceeds limit');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function clearPluginPrivateStorage(
  pluginId: string,
  fingerprint: string,
): Promise<void> {
  const prefix = 'kv:' + pluginId + ':' + fingerprint + ':';
  await storageWrites.get(prefix)?.catch(() => {});
  const rows = await listPluginRecords(prefix);
  await writePluginRecords(
    {},
    rows.map((row) => row.key),
  );
}
