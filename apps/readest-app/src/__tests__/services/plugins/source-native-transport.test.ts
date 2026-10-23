import { beforeEach, expect, it, vi } from 'vitest';
import { sourceTransport } from '@/services/contentSources/network';

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
beforeEach(() => {
  native.invoke.mockReset();
});
const input = { method: 'GET', headers: {}, allowPrivateNetwork: false };

it('preserves native string failure codes and stages for iOS diagnostics', async () => {
  native.invoke.mockRejectedValueOnce('SOURCE_HTTP_DNS_FAILED');
  await expect(
    sourceTransport('https://cdn.example/index.json', input, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'SOURCE_HTTP_DNS_FAILED', stage: 'dns', retryable: true });
});

it('accepts structured native errors without exposing untrusted messages', async () => {
  native.invoke.mockRejectedValueOnce({
    code: 'SOURCE_HTTP_TLS_FAILED',
    stage: 'tls',
    retryable: false,
    message: 'https://cdn.example/?apiKey=PRIVATE_KEY Cookie: PRIVATE_COOKIE',
  });
  const error = await sourceTransport(
    'https://cdn.example/index.json',
    input,
    new AbortController().signal,
  ).catch((failure: unknown) => failure);
  expect(error).toMatchObject({ code: 'SOURCE_HTTP_TLS_FAILED', stage: 'tls', retryable: false });
  expect(JSON.stringify(error)).not.toMatch(/PRIVATE_KEY|PRIVATE_COOKIE/);
});

it('distinguishes cancellation from failure and forwards cancellation to the native request', async () => {
  const controller = new AbortController();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'source_http_cancel') return;
    await new Promise<void>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw 'SOURCE_HTTP_CANCELLED';
  });
  const result = sourceTransport('https://cdn.example/index.json', input, controller.signal);
  controller.abort();
  await expect(result).rejects.toMatchObject({
    name: 'AbortError',
    code: 'SOURCE_HTTP_CANCELLED',
    retryable: false,
  });
  expect(native.invoke).toHaveBeenCalledWith(
    'source_http_cancel',
    expect.objectContaining({ requestId: expect.any(String) }),
  );
});

it('preserves a host timeout when the native command acknowledges it as cancellation', async () => {
  const controller = new AbortController();
  native.invoke.mockImplementation(async (command: string) => {
    if (command === 'source_http_cancel') return;
    await new Promise<void>((resolve) =>
      controller.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
    throw 'SOURCE_HTTP_CANCELLED';
  });
  const result = sourceTransport('https://cdn.example/index.json', input, controller.signal);
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await expect(result).rejects.toMatchObject({ code: 'SOURCE_HTTP_TIMEOUT', retryable: true });
});
