import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMetadata } from '@/app/s/page';
import { resolveActiveShare } from '@/libs/shareServer';

vi.mock('@/libs/shareServer', () => ({ resolveActiveShare: vi.fn(async () => ({ ok: false })) }));
vi.mock('@/app/s/ShareLanding', () => ({ default: () => null }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('share metadata in downloadable Web builds', () => {
  it('never consumes request searchParams during a static export', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    vi.stubEnv('BUILD_STATIC_WEB', 'true');
    const searchParams = {
      // biome-ignore lint/suspicious/noThenProperty: Simulate request-bound Next.js searchParams that cannot be awaited during export.
      then: () => {
        throw new Error('Dynamic request access during export');
      },
    } as unknown as Promise<Record<string, string>>;
    await expect(generateMetadata({ searchParams })).resolves.toMatchObject({
      title: 'Open in Readest',
    });
    expect(resolveActiveShare).not.toHaveBeenCalled();
  });

  it('keeps token lookup enabled for the hosted server', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    vi.stubEnv('BUILD_STATIC_WEB', 'false');
    await generateMetadata({ searchParams: Promise.resolve({ token: 'share-token' }) });
    expect(resolveActiveShare).toHaveBeenCalledWith('share-token');
  });
});
