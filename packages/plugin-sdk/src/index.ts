export * from './contract';
export * from './library';
export * from './worker';
export * from './content';
export * from './plugin';
import type { HttpRequest, HttpResponse, LibraryContext } from './library';
import type { PluginWorkerOperationContext } from './worker';

export async function requestJson<T>(
  host: PluginWorkerOperationContext,
  context: LibraryContext,
  request: Omit<HttpRequest, 'connection'>,
): Promise<T> {
  const response = (await host.call('http.request', {
    ...request,
    connection: context.connection,
  })) as HttpResponse;
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Server returned HTTP ${response.status}`);
  if (response.status === 204 || !response.bytes.byteLength) return undefined as T;
  return JSON.parse(new TextDecoder().decode(response.bytes)) as T;
}

/** Read an asset from this plugin's verified signed archive. No network or host paths. */
export function readBundledResource(path: string): Uint8Array {
  const resources = (
    globalThis as typeof globalThis & { __READEST_PLUGIN_RESOURCES__?: Record<string, string> }
  ).__READEST_PLUGIN_RESOURCES__;
  if (!resources || !Object.hasOwn(resources, path))
    throw new Error('Bundled resource is unavailable');
  return Uint8Array.from(atob(resources[path]!), (char) => char.charCodeAt(0));
}
