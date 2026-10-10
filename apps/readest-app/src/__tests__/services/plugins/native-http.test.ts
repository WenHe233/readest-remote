// @vitest-environment node
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
beforeEach(() => {
  invoke.mockReset();
  vi.stubGlobal('window', { __TAURI_INTERNALS__: { invoke } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});
it('does not cancel released native HTTP resources when the operation signal expires later', async () => {
  let reads = 0;
  invoke.mockImplementation(async (command: string) => {
    if (command === 'plugin:http|fetch') return 1;
    if (command === 'plugin:http|fetch_send')
      return { status: 200, statusText: 'OK', url: 'http://localhost/file', headers: [], rid: 2 };
    if (command === 'plugin:http|fetch_read_body')
      return (++reads === 1 ? new Uint8Array([65, 0]) : new Uint8Array([1])).buffer;
    throw new Error('Resource already released');
  });
  const controller = new AbortController();
  const response = await nativeFetch('http://localhost/file', { signal: controller.signal });
  expect(await response.text()).toBe('A');
  controller.abort();
  await new Promise((r) => setTimeout(r, 0));
  expect(invoke.mock.calls.filter(([command]) => String(command).includes('cancel'))).toHaveLength(
    0,
  );
});
it('cancels a live body once and removes its abort listeners', async () => {
  let finish: (value: ArrayBuffer) => void = () => {};
  invoke.mockImplementation(async (command: string) => {
    if (command === 'plugin:http|fetch') return 1;
    if (command === 'plugin:http|fetch_send')
      return { status: 200, statusText: 'OK', url: 'http://localhost/file', headers: [], rid: 2 };
    if (command === 'plugin:http|fetch_read_body')
      return new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      });
    if (command === 'plugin:http|fetch_cancel_body') return;
    throw new Error('Unexpected request cancellation after headers');
  });
  const controller = new AbortController();
  const response = await nativeFetch('http://localhost/file', { signal: controller.signal });
  const read = response.text();
  const failure = expect(read).rejects.toBeDefined();
  controller.abort();
  await failure;
  finish(new Uint8Array([1]).buffer);
  await new Promise((r) => setTimeout(r, 0));
  expect(
    invoke.mock.calls.filter(([command]) => command === 'plugin:http|fetch_cancel_body'),
  ).toHaveLength(1);
});
