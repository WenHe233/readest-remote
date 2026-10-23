import { invoke } from '@tauri-apps/api/core';
import type {
  PluginPermissions,
  SourceContext,
  SourceDefinition,
  PluginHostCall,
  Json,
} from '@readest/plugin-sdk';
import { isTauriAppPlatform } from '@/services/environment';
import { anySignal } from '@/utils/abort';
import { readBoundedBody } from '../plugins/httpBroker';
import { listPluginRecords, writePluginRecords } from '../plugins/persistence';
import { PluginRuntimeError, type PluginHostCallHandler } from '../plugins/runtime';
import type { SourceInstance } from './instances';
import { assertSourceUrl, SourceAccessError } from './policy';
import { sourceCookieHeader, updateSourceCookies, type SourceCookie } from './cookies';
import { requestSourceInteraction } from './interactions';
import { queueSourceOrigin } from './permissions';
import {
  readSourcePrivateValue,
  writeSourcePrivateValue,
  type EncryptedSourceValue,
  sourcePrivateScope,
  readSourceCredentials,
} from './privateStorage';

type Request = Extract<PluginHostCall, { capability: 'source.http' }>['payload'];
interface TransportResult {
  status: number;
  url: string;
  headers: Record<string, string>;
  bytes: Uint8Array;
  setCookies: string[];
}
export type SourceTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: Uint8Array;
    allowPrivateNetwork: boolean;
  },
  signal: AbortSignal,
) => Promise<TransportResult>;
const MAX_RESPONSE = 32 * 1024 * 1024;
const MAX_BODY = 4 * 1024 * 1024;
const storageQueues = new Map<string, Promise<unknown>>();
const pluginTasks = new Map<string, Set<Promise<unknown>>>();
export async function drainSourceOperations(pluginId: string): Promise<void> {
  while (pluginTasks.get(pluginId)?.size) await Promise.allSettled([...pluginTasks.get(pluginId)!]);
}

export const sourceTransport: SourceTransport = async (url, init, signal) => {
  signal.throwIfAborted();
  if (isTauriAppPlatform()) {
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void invoke('source_http_cancel', { requestId }).catch(() => {});
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await invoke<Omit<TransportResult, 'bytes'> & { bytes: number[] }>(
        'source_http_request',
        {
          request: {
            requestId,
            url,
            ...init,
            body: init.body ? [...init.body] : undefined,
            timeoutMs: 30000,
            maxBytes: MAX_RESPONSE,
          },
        },
      );
      signal.throwIfAborted();
      return { ...result, bytes: new Uint8Array(result.bytes) };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  const headers = new Headers(init.headers);
  if (['cookie', 'referer', 'user-agent', 'origin'].some((name) => headers.has(name)))
    throw new SourceAccessError(
      'This source requires request headers unavailable in the web browser. Use a native client.',
      'SOURCE_PLATFORM_UNSUPPORTED',
    );
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers,
      body: init.body ? new Uint8Array(init.body) : undefined,
      redirect: 'manual',
      credentials: 'omit',
      signal,
    });
  } catch {
    signal.throwIfAborted();
    throw new SourceAccessError(
      'The browser could not access this source. It may require CORS support or a native client.',
      'SOURCE_NETWORK_FAILED',
    );
  }
  if (response.type === 'opaqueredirect')
    throw new SourceAccessError(
      'The browser cannot inspect this redirect. Use a native client.',
      'SOURCE_PLATFORM_UNSUPPORTED',
    );
  return {
    status: response.status,
    url: response.url || url,
    headers: Object.fromEntries(response.headers.entries()),
    bytes: await readBoundedBody(response, MAX_RESPONSE),
    setCookies: [],
  };
};

export function createSourceLease(
  instance: SourceInstance,
  permissions: PluginPermissions,
  allowed: () => boolean,
  definition?: SourceDefinition,
  transport: SourceTransport = sourceTransport,
  inspectOnly = false,
) {
  const controller = new AbortController();
  const tasks = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    const group = pluginTasks.get(instance.pluginId) ?? new Set<Promise<unknown>>();
    pluginTasks.set(instance.pluginId, group);
    const tracked = operation.finally(() => {
      tasks.delete(tracked);
      group.delete(tracked);
      if (!group.size && pluginTasks.get(instance.pluginId) === group)
        pluginTasks.delete(instance.pluginId);
    });
    tasks.add(tracked);
    group.add(tracked);
    return tracked;
  };
  const slots = new Map<string, string>();
  const context: SourceContext = {
    instance: crypto.randomUUID(),
    providerId: instance.providerId,
    config: instance.config,
    definition,
    networkOrigins: instance.origins,
    secrets: {},
  };
  for (const name of instance.secretNames) {
    const token = crypto.randomUUID();
    slots.set(token, name);
    context.secrets![name] = token;
  }
  const prefix = sourcePrivateScope('kv', instance);
  const cookieScope = sourcePrivateScope('cookie', instance);
  const targetUrl = (value: string) => {
    try {
      return assertSourceUrl(value, instance);
    } catch (error) {
      if (
        error instanceof SourceAccessError &&
        error.code === 'SOURCE_ORIGIN_REQUIRED' &&
        error.origin
      )
        queueSourceOrigin(instance.id, error.origin);
      throw error;
    }
  };
  let cookieWrites: Promise<unknown> = Promise.resolve();
  let jar: SourceCookie[] | undefined;
  const check = (lease = context.instance) => {
    controller.signal.throwIfAborted();
    if (!allowed() || lease !== context.instance)
      throw new SourceAccessError('Source permission was revoked.');
  };
  const readJar = async () => {
    await cookieWrites;
    if (!jar) {
      const saved = await readSourcePrivateValue(cookieScope, cookieScope + 'jar');
      jar = Array.isArray(saved) ? (saved as unknown as SourceCookie[]) : [];
    }
    return jar;
  };
  const saveCookies = async (url: string, lines: string[]) => {
    const operation = cookieWrites
      .catch(() => {})
      .then(async () => {
        check();
        if (!jar) {
          const stored = await readSourcePrivateValue(cookieScope, cookieScope + 'jar');
          jar = Array.isArray(stored) ? (stored as unknown as SourceCookie[]) : [];
        }
        jar = updateSourceCookies(jar, url, lines);
        await writeSourcePrivateValue(
          cookieScope,
          cookieScope + 'jar',
          JSON.parse(JSON.stringify(jar)) as Json,
        );
      });
    cookieWrites = operation;
    await operation;
  };
  const executeRequest = async (input: Request, signal?: AbortSignal) => {
    check(input.instance);
    if (inspectOnly || !permissions.network)
      throw new SourceAccessError('This operation has no network permission.');
    let url = targetUrl(input.url);
    const headers = new Headers(input.headers);
    for (const key of [
      'host',
      'origin',
      'proxy-authorization',
      'connection',
      'transfer-encoding',
      'content-length',
    ])
      if (headers.has(key)) throw new SourceAccessError(`Restricted request header: ${key}`);
    const cookie = headers.get('cookie');
    if (cookie) {
      if (!permissions.cookies)
        throw new SourceAccessError('This plugin has no Cookie permission.');
      await saveCookies(
        url.href,
        cookie.split(';').map((pair) => `${pair.trim()}; Path=/`),
      );
      headers.delete('cookie');
    }
    const credentials = input.auth?.length ? await readSourceCredentials(instance) : {};
    const secretHeaders = new Set(['authorization', 'x-api-key']);
    const secretQueries = new Set<string>();
    for (const binding of input.auth ?? []) {
      if (
        binding.in === 'header' &&
        [
          'host',
          'origin',
          'cookie',
          'proxy-authorization',
          'connection',
          'transfer-encoding',
          'content-length',
        ].includes(binding.name.toLowerCase())
      )
        throw new SourceAccessError('A credential cannot target a restricted request header.');
      const name = slots.get(binding.secret);
      if (!permissions.secrets || !name || !(name in credentials))
        throw new SourceAccessError('Source credential is unavailable.');
      if (binding.in === 'header') {
        headers.set(binding.name, credentials[name]!);
        secretHeaders.add(binding.name.toLowerCase());
      } else {
        url.searchParams.set(binding.name, credentials[name]!);
        secretQueries.add(binding.name);
      }
    }
    if (input.body !== undefined && input.json !== undefined)
      throw new SourceAccessError(
        'Provide either body or JSON, not both.',
        'SOURCE_INVALID_REQUEST',
      );
    let body =
      input.json !== undefined
        ? new TextEncoder().encode(JSON.stringify(input.json))
        : typeof input.body === 'string'
          ? new TextEncoder().encode(input.body)
          : input.body;
    if (input.json !== undefined) headers.set('content-type', 'application/json');
    if (body && body.byteLength > MAX_BODY)
      throw new SourceAccessError(
        'Source request exceeds the size limit.',
        'SOURCE_LIMIT_EXCEEDED',
      );
    let method = input.method || 'GET';
    const abort = anySignal(
      controller.signal,
      signal,
      AbortSignal.timeout(Math.min(input.timeoutMs || 30000, 60000)),
    );
    try {
      for (let hop = 0; hop < 6; hop++) {
        check(input.instance);
        abort.signal.throwIfAborted();
        targetUrl(url.href);
        const outgoing = new Headers(headers);
        if (permissions.cookies) {
          const cookies = sourceCookieHeader(await readJar(), url.href);
          if (cookies) outgoing.set('cookie', cookies);
        }
        const result = await transport(
          url.href,
          {
            method,
            headers: Object.fromEntries(outgoing.entries()),
            body,
            allowPrivateNetwork: instance.allowPrivateNetwork,
          },
          abort.signal,
        );
        check(input.instance);
        abort.signal.throwIfAborted();
        if (result.bytes.byteLength > MAX_RESPONSE)
          throw new SourceAccessError(
            'Source response exceeds the size limit.',
            'SOURCE_LIMIT_EXCEEDED',
          );
        if (permissions.cookies && result.setCookies.length)
          await saveCookies(url.href, result.setCookies);
        const returned = new Headers(result.headers);
        returned.delete('set-cookie');
        if (![301, 302, 303, 307, 308].includes(result.status)) {
          const publicUrl = new URL(url);
          for (const name of secretQueries) publicUrl.searchParams.delete(name);
          return {
            status: result.status,
            url: publicUrl.href,
            headers: Object.fromEntries(returned.entries()),
            bytes: result.bytes,
          };
        }
        const location = returned.get('location');
        if (!location)
          throw new SourceAccessError('Source redirect has no location.', 'SOURCE_NETWORK_FAILED');
        const target = targetUrl(new URL(location, url).href);
        if (target.origin !== url.origin) {
          for (const name of secretHeaders) headers.delete(name);
          for (const name of secretQueries) target.searchParams.delete(name);
          if (method !== 'GET' && method !== 'HEAD')
            throw new SourceAccessError(
              'A source cannot redirect a request body to another origin.',
            );
        }
        if (
          result.status === 303 ||
          ((result.status === 301 || result.status === 302) && method === 'POST')
        ) {
          method = 'GET';
          body = undefined;
          headers.delete('content-type');
        }
        url = target;
      }
      throw new SourceAccessError('Too many source redirects.', 'SOURCE_NETWORK_FAILED');
    } finally {
      abort.cleanup();
    }
  };
  const request = (input: Request, signal?: AbortSignal) => track(executeRequest(input, signal));
  const executeHostCall: PluginHostCallHandler = async (call, owner, signal) => {
    try {
      check();
      signal.throwIfAborted();
      if (
        !('context' in owner.payload) ||
        !('instance' in owner.payload.context) ||
        owner.payload.context.instance !== context.instance ||
        !('instance' in call.payload) ||
        call.payload.instance !== context.instance
      )
        throw new SourceAccessError('Source request scope denied.');
      if (call.capability === 'source.http') return await request(call.payload, signal);
      if (inspectOnly)
        throw new SourceAccessError('Import inspection cannot access instance state.');
      if (call.capability === 'source.cookies.get' || call.capability === 'source.cookies.set') {
        if (!permissions.cookies)
          throw new SourceAccessError('This plugin has no Cookie permission.');
        const url = targetUrl(call.payload.url).href;
        if (call.capability === 'source.cookies.get')
          return { cookie: sourceCookieHeader(await readJar(), url) };
        await saveCookies(url, [call.payload.cookie]);
        return { saved: true };
      }
      if (call.capability === 'source.interaction') {
        if (!permissions.interaction)
          throw new SourceAccessError('This plugin has no interaction permission.');
        return await requestSourceInteraction(instance.id, call.payload.request, signal);
      }
      if (!permissions.storage)
        throw new SourceAccessError('This plugin has no storage permission.');
      if (call.capability === 'source.storage.get')
        return await readSourcePrivateValue(prefix, prefix + call.payload.key);
      if (call.capability === 'source.storage.set' || call.capability === 'source.storage.delete') {
        const op = (storageQueues.get(prefix) ?? Promise.resolve())
          .catch(() => {})
          .then(async () => {
            check();
            signal.throwIfAborted();
            if (call.capability === 'source.storage.delete') {
              await writePluginRecords({}, [prefix + call.payload.key]);
              return { deleted: true };
            }
            const size = new TextEncoder().encode(JSON.stringify(call.payload.value)).length;
            const rows = await listPluginRecords<EncryptedSourceValue>(prefix);
            const total = rows
              .filter((row) => row.key !== prefix + call.payload.key)
              .reduce((sum, row) => sum + row.value.size, size);
            if (total > 2 * 1024 * 1024)
              throw new SourceAccessError(
                'Source storage quota exceeded.',
                'SOURCE_LIMIT_EXCEEDED',
              );
            await writeSourcePrivateValue(prefix, prefix + call.payload.key, call.payload.value);
            return { saved: true };
          });
        storageQueues.set(prefix, op);
        try {
          return await op;
        } finally {
          if (storageQueues.get(prefix) === op) storageQueues.delete(prefix);
        }
      }
      throw new SourceAccessError(
        'Unsupported source host capability.',
        'SOURCE_UNSUPPORTED_CAPABILITY',
      );
    } catch (error) {
      if (error instanceof SourceAccessError)
        throw new PluginRuntimeError(error.message, error.code);
      throw error;
    }
  };
  const handleHostCall: PluginHostCallHandler = (call, owner, signal) =>
    track(executeHostCall(call, owner, signal));
  return {
    context,
    request,
    handleHostCall,
    busy: () => tasks.size > 0,
    close: () => controller.abort(),
  };
}
