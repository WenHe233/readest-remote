import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { page } from 'vitest/browser';
import { DropdownProvider } from '@/context/DropdownContext';
import Menu from '@/components/Menu';
import LibraryHeader from '@/app/library/components/LibraryHeader';
import { DEFAULT_BOOK_SEARCH_CONFIG } from '@/services/constants';
import type { ComponentProps } from 'react';

vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (s: string) => s }));
vi.mock('@/hooks/useTrafficLight', () => ({
  useTrafficLight: () => ({ isTrafficLightVisible: false }),
}));
vi.mock('@/hooks/useShortcuts', () => ({ default: () => {} }));
vi.mock('@/app/library/components/SettingsMenu', () => ({
  default: () => <Menu className='settings-menu dropdown-content no-triangle mt-2'>Settings</Menu>,
}));
vi.mock('@/app/library/components/ImportMenu', () => ({ default: () => null }));
vi.mock('@/app/library/components/ViewMenu', () => ({
  default: () => (
    <Menu
      className='view-menu dropdown-content no-triangle mt-2'
      style={{ marginRight: window.innerWidth < 640 ? '-40px' : 0 }}
    >
      View
    </Menu>
  ),
}));
await import('@/styles/globals.css');
const noop = () => {};
afterEach(() => {
  cleanup();
  document.documentElement.dir = 'ltr';
});

const renderHeader = (overrides: Partial<ComponentProps<typeof LibraryHeader>> = {}) =>
  render(
    <DropdownProvider>
      <div className='relative w-full'>
        <LibraryHeader
          isSelectMode={false}
          isSelectAll={false}
          searchQuery=''
          searchTarget='books'
          searchConfig={DEFAULT_BOOK_SEARCH_CONFIG}
          onPullLibrary={noop}
          onImportBooksFromFiles={noop}
          onOpenCatalogManager={noop}
          onOpenFeeds={noop}
          onToggleSelectMode={noop}
          onSelectAll={noop}
          onDeselectAll={noop}
          onSearchConfigChange={noop}
          onSearchQueryChange={noop}
          onSearchTargetChange={noop}
          {...overrides}
        />
      </div>
    </DropdownProvider>,
  );

describe('library search actions', () => {
  it('opens a multi-select range menu within the mobile viewport and submits only explicitly', async () => {
    await page.viewport(390, 844);
    const submit = vi.fn();
    const scopesChanged = vi.fn();
    const { getByRole, getByText } = renderHeader({
      searchQuery: 'needle',
      searchScopes: [
        { id: 'local', kind: 'local', name: 'Local imports' },
        { id: 'source:a', kind: 'source', name: 'A source', instanceId: 'a' },
      ],
      selectedSearchScopes: ['local'],
      onSearchSubmit: submit,
      onSearchScopesChange: scopesChanged,
    });
    const toggle = getByRole('button', { name: 'Search scope' });
    fireEvent.click(toggle);
    const option = getByRole('checkbox', { name: 'A source' });
    const menu = getByText('Full text searches downloaded text on this device only').parentElement!;
    expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      toggle.getBoundingClientRect().bottom,
    );
    expect(menu.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    expect(menu.getBoundingClientRect().right).toBeLessThanOrEqual(390);
    fireEvent.click(option);
    expect(scopesChanged).toHaveBeenCalledWith(['local', 'source:a']);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.keyDown(getByRole('textbox'), { key: 'Enter' });
    expect(submit).toHaveBeenCalledOnce();
  });
  for (const width of [768, 1200]) {
    for (const dir of ['ltr', 'rtl']) {
      it(`centers Select Books between Import and the input end at ${width}px in ${dir}`, async () => {
        await page.viewport(width, 900);
        document.documentElement.dir = dir;
        const { getByRole } = renderHeader();
        const input = getByRole('textbox').getBoundingClientRect();
        const plus = getByRole('button', { name: 'Import Books' }).getBoundingClientRect();
        const select = getByRole('button', { name: 'Select Books' }).getBoundingClientRect();
        const plusCenter = (plus.left + plus.right) / 2;
        const selectCenter = (select.left + select.right) / 2;
        expect(selectCenter).toBeCloseTo(
          (plusCenter + (dir === 'ltr' ? input.right : input.left)) / 2,
          0,
        );
      });
    }
  }
});

it.each([
  390, 627,
])('matches mobile menu gaps and dismisses outside taps at %ipx', async (width) => {
  await page.viewport(width, 900);
  const { container, getByRole } = renderHeader();
  const gaps: number[] = [];
  for (const [label, selector] of [
    ['View Menu', '.view-menu'],
    ['Settings Menu', '.settings-menu'],
  ]) {
    const toggle = getByRole('button', { name: label });
    fireEvent.click(toggle);
    const menu = container.querySelector(selector!) as HTMLElement;
    const overlay = container.querySelector('.overlay') as HTMLElement;
    gaps.push(menu.getBoundingClientRect().top - toggle.getBoundingClientRect().bottom);
    expect(menu.getBoundingClientRect().right).toBe(width - 16);
    expect(getComputedStyle(overlay).position).toBe('fixed');
    const outside = document.elementFromPoint(16, 880) as HTMLElement;
    expect(outside).toBe(overlay);
    fireEvent.click(outside);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  }
  expect(gaps[0]).toBe(gaps[1]);
});
