import type { SystemSettings } from '@/types/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

describe('builds without Readest Cloud', () => {
  it('overrides an enabled cloud provider without disabling external providers', async () => {
    vi.stubEnv('NEXT_PUBLIC_READEST_CLOUD_ENABLED', 'false');
    const { getCloudSyncProviders } = await import('@/services/sync/cloudSyncProvider');
    const settings = { readestCloud: { enabled: true }, webdav: { enabled: true } };
    expect(getCloudSyncProviders(settings as SystemSettings)).toEqual(['webdav']);
  });

  it('does not restore a stored session or make a network request', async () => {
    vi.stubEnv('NEXT_PUBLIC_READEST_CLOUD_ENABLED', 'false');
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    localStorage.setItem('token', 'legacy-test-token');
    localStorage.setItem('user', JSON.stringify({ id: 'legacy-test-user' }));
    const { getAccessToken, getUserID } = await import('@/utils/access');
    expect(await getAccessToken()).toBeNull();
    expect(await getUserID()).toBeNull();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { supabase, createSupabaseClient } = await import('@/utils/supabase');
    expect((await supabase.auth.getSession()).data.session).toBeNull();
    const result = await createSupabaseClient('old-token').from('replica').select();
    expect(result.error).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
});
