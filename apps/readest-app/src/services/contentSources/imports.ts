import { SourceOperationError } from './errors';
import { sourceTransport } from './network';
import { assertSourceUrl, normalizeSourceOrigin } from './policy';

/** User-selected source files use the same checked native transport as content. */
export async function downloadSourceInput(input: string, signal: AbortSignal) {
  let url = new URL(input);
  const visited = new Set<string>();
  for (let redirects = 0; redirects <= 5; redirects++) {
    signal.throwIfAborted();
    assertSourceUrl(url.href, {
      origins: [normalizeSourceOrigin(url.href)],
      allowPrivateNetwork: false,
    });
    if (visited.has(url.href))
      throw Object.assign(new Error('Source URL redirects in a loop'), {
        code: 'SOURCE_REDIRECT_LOOP',
      });
    visited.add(url.href);
    const response = await sourceTransport(
      url.href,
      { method: 'GET', headers: {}, allowPrivateNetwork: false },
      signal,
    );
    if (response.status >= 300 && response.status < 400 && response.headers['location']) {
      url = new URL(response.headers['location'], url);
      continue;
    }
    if (response.status < 200 || response.status >= 300)
      throw new SourceOperationError('SOURCE_HTTP_STATUS', 'download-source', {
        status: response.status,
      });
    if (response.bytes.length > 4 * 1024 * 1024)
      throw Object.assign(new Error('Source file exceeds 4 MiB'), {
        code: 'SOURCE_LIMIT_EXCEEDED',
      });
    return { content: new TextDecoder().decode(response.bytes), url: response.url || url.href };
  }
  throw Object.assign(new Error('Too many source redirects'), { code: 'SOURCE_REDIRECT_LIMIT' });
}
