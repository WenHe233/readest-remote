import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { page } from 'vitest/browser';
import ViewMenu from '@/app/library/components/ViewMenu';
import Dropdown from '@/components/Dropdown';
import { DropdownProvider } from '@/context/DropdownContext';
import { useSettingsStore } from '@/store/settingsStore';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import type { SystemSettings } from '@/types/settings';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/helpers/settings', () => ({
  saveSysSettings: async (_env: unknown, key: string, value: unknown) => {
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, [key]: value },
    });
  },
}));
vi.mock('@/utils/nav', () => ({ navigateToLibrary: vi.fn() }));
await import('@/styles/globals.css');

beforeEach(() =>
  useSettingsStore.setState({ settings: { ...DEFAULT_SYSTEM_SETTINGS } as SystemSettings }),
);
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset['eink'];
});

for (const eink of [false, true]) {
  it(`keeps multiple library choices usable in the mobile view menu (e-ink: ${eink})`, async () => {
    await page.viewport(375, 812);
    document.documentElement.dataset['eink'] = String(eink);
    render(
      <DropdownProvider>
        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '16px 48px' }}>
          <Dropdown
            label='View Menu'
            className='dropdown-bottom dropdown-end'
            toggleButton={<span>View</span>}
          >
            <ViewMenu
              libraryOptions={[
                { id: 'local', name: 'Local imports' },
                { id: 'library:server:comics', name: 'Komga / Comics' },
                { id: 'source:one', name: 'My source' },
              ]}
            />
          </Dropdown>
        </div>
      </DropdownProvider>,
    );
    await page.getByRole('button', { name: 'View Menu' }).click();
    await page.getByRole('button', { name: 'Filter libraries...' }).click();
    await page.getByRole('menuitem', { name: 'Local imports - ON' }).click();
    await page.getByRole('menuitem', { name: 'Komga / Comics - ON' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'My source - ON' })).toBeVisible();
    expect(useSettingsStore.getState().settings.libraryFilter).toEqual(['source:one']);
    const menu = document.querySelector<HTMLElement>('.view-menu')!;
    expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(15);
    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(360);
    await page.getByRole('menuitem', { name: 'All libraries - OFF' }).click();
    expect(useSettingsStore.getState().settings.libraryFilter).toBeNull();
  });
}
