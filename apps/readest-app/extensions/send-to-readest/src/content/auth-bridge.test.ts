import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installChromeMock,
  uninstallChromeMock,
  type ChromeMock,
} from '../__test-utils__/chromeMock';

/**
 * `auth-bridge.ts` is a side-effect content script — its module-load
 * IIFE syncs the token immediately and installs a `storage` event
 * listener. We use `vi.resetModules()` between cases so each `import`
 * re-runs that IIFE against the test's fresh localStorage.
 */

let chromeMock: ChromeMock;
let addEventListenerSpy: ReturnType<typeof vi.spyOn>;
const experimentSessionKey =
  'io.github.wenhe233.readestremote.experimental:readest-remote-experimental-auth';

beforeEach(() => {
  vi.useFakeTimers();
  chromeMock = installChromeMock();
  localStorage.clear();
  addEventListenerSpy = vi.spyOn(window, 'addEventListener');
  vi.resetModules();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  addEventListenerSpy.mockRestore();
  uninstallChromeMock();
  localStorage.clear();
});

describe('auth-bridge — token extraction', () => {
  test('writes a fresh token to chrome.storage when localStorage has a Supabase session', async () => {
    localStorage.setItem(
      experimentSessionKey,
      JSON.stringify({ access_token: 'abc-token', refresh_token: 'r' }),
    );
    await import('./auth-bridge');

    expect(chromeMock.storage.local.set).toHaveBeenCalledTimes(1);
    const call = chromeMock.storage.local.set.mock.calls[0]![0] as Record<string, unknown>;
    expect(call['readestAccessToken']).toBe('abc-token');
    expect(typeof call['readestTokenAt']).toBe('number');
  });

  test('clears the stored token when no Supabase session is present', async () => {
    // Pre-seed the extension storage so we can confirm clearing.
    await chromeMock.storage.local.set({
      readestAccessToken: 'stale',
      readestTokenAt: 12345,
    });
    chromeMock.storage.local.remove.mockClear();

    await import('./auth-bridge');
    expect(chromeMock.storage.local.remove).toHaveBeenCalledWith([
      'readestAccessToken',
      'readestTokenAt',
    ]);
  });

  test('ignores the stable app Supabase auth token', async () => {
    localStorage.setItem('unrelated-key', JSON.stringify({ access_token: 'nope' }));
    localStorage.setItem('sb-stable-auth-token', JSON.stringify({ access_token: 'stable-token' }));

    await import('./auth-bridge');
    // The experimental extension must not reuse the stable application's login.
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
    expect(chromeMock.storage.local.remove).toHaveBeenCalled();
  });

  test('tolerates malformed JSON in a matching key', async () => {
    localStorage.setItem(experimentSessionKey, '{not valid json');

    await expect(import('./auth-bridge')).resolves.toBeDefined();
    // The malformed entry counts as "no token found" → clear.
    expect(chromeMock.storage.local.remove).toHaveBeenCalled();
  });

  test('skips entries whose access_token is missing or not a string', async () => {
    localStorage.setItem(experimentSessionKey, JSON.stringify({ access_token: 42 }));

    await import('./auth-bridge');
    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
  });

  test('selects the experimental session when both app profiles have signed in', async () => {
    localStorage.setItem('sb-alpha-auth-token', JSON.stringify({ access_token: 'alpha-token' }));
    localStorage.setItem(
      experimentSessionKey,
      JSON.stringify({ access_token: 'experiment-token' }),
    );

    await import('./auth-bridge');
    expect(chromeMock.storage.local.set).toHaveBeenCalledTimes(1);
    const stored = (chromeMock.storage.local.set.mock.calls[0]![0] as Record<string, unknown>)[
      'readestAccessToken'
    ];
    expect(stored).toBe('experiment-token');
  });

  test('installs a `storage` event listener for token rotation', async () => {
    await import('./auth-bridge');
    const calls = addEventListenerSpy.mock.calls.filter((c) => c[0] === 'storage');
    expect(calls.length).toBe(1);
  });

  test('polls for same-page token writes that do not fire a storage event', async () => {
    await import('./auth-bridge');
    chromeMock.storage.local.set.mockClear();
    chromeMock.storage.local.remove.mockClear();

    localStorage.setItem(experimentSessionKey, JSON.stringify({ access_token: 'same-page-token' }));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(chromeMock.storage.local.set).toHaveBeenCalledTimes(1);
    expect(
      (chromeMock.storage.local.set.mock.calls[0]![0] as Record<string, unknown>)[
        'readestAccessToken'
      ],
    ).toBe('same-page-token');
  });

  test('storage events from the stable app are ignored', async () => {
    await import('./auth-bridge');
    chromeMock.storage.local.set.mockClear();
    chromeMock.storage.local.remove.mockClear();

    const handler = addEventListenerSpy.mock.calls.find((c) => c[0] === 'storage')?.[1] as (
      e: StorageEvent,
    ) => void;
    localStorage.setItem(
      experimentSessionKey,
      JSON.stringify({ access_token: 'experiment-token' }),
    );
    handler(new StorageEvent('storage', { key: 'sb-stable-auth-token', newValue: 'stable-token' }));

    expect(chromeMock.storage.local.set).not.toHaveBeenCalled();
    expect(chromeMock.storage.local.remove).not.toHaveBeenCalled();
  });

  test('storage event with a matching key re-syncs the token', async () => {
    await import('./auth-bridge');
    chromeMock.storage.local.set.mockClear();

    localStorage.setItem(experimentSessionKey, JSON.stringify({ access_token: 'new-token' }));
    const handler = addEventListenerSpy.mock.calls.find((c) => c[0] === 'storage')?.[1] as (
      e: StorageEvent,
    ) => void;
    handler(new StorageEvent('storage', { key: experimentSessionKey, newValue: 'x' }));

    expect(chromeMock.storage.local.set).toHaveBeenCalledTimes(1);
    expect(
      (chromeMock.storage.local.set.mock.calls[0]![0] as Record<string, unknown>)[
        'readestAccessToken'
      ],
    ).toBe('new-token');
  });
});
