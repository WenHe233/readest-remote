import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { page } from 'vitest/browser';
import zh from '../../../../public/locales/zh-CN/translation.json';
const locale = vi.hoisted(() => ({ language: 'en' }));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (key: string) =>
    locale.language === 'zh-CN' ? ((zh as Record<string, string>)[key] ?? key) : key,
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
const { default: PluginsPanel } = await import('@/components/settings/PluginsPanel');
const { usePluginInbox } = await import('@/services/plugins/inbox');
const { verifyPluginPackage } = await import('@/services/plugins/package');
const { findInstalledPlugin, uninstallPlugin } = await import('@/services/plugins/manager');
await import('@/styles/globals.css');
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_ARTIFACTS__: string;
afterEach(() => {
  cleanup();
  delete document.documentElement.dataset['eink'];
});
const mount = () =>
  render(
    createElement(
      'div',
      { className: 'bg-base-100 p-6', style: { width: 720 } },
      createElement(PluginsPanel),
    ),
  );
describe('external plugin management interface', () => {
  it('reviews a real signature and permissions, installs, revokes network and opens the connection form', async () => {
    locale.language = 'en';
    const pkg = await verifyPluginPackage(
      Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__['kavita']!), (c) => c.charCodeAt(0)),
    );
    await uninstallPlugin(pkg.manifest.id);
    mount();
    await vi.waitFor(() => expect(screen.queryByText('Working…')).toBeNull());
    usePluginInbox.setState({ candidate: pkg });
    await vi.waitFor(() => expect(screen.getByText('Signer: ' + pkg.fingerprint)).toBeTruthy());
    expect(screen.getByText('Configured server network')).toBeTruthy();
    await page.screenshot({ path: __PLUGIN_TEST_ARTIFACTS__ + '/plugin-install-en.png' });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and install' }));
    await vi.waitFor(() => expect(findInstalledPlugin(pkg.manifest.id)?.enabled).toBe(true));
    await vi.waitFor(() => expect(screen.queryByText('Working…')).toBeNull());
    await page.screenshot({ path: __PLUGIN_TEST_ARTIFACTS__ + '/plugin-manager-en.png' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Configured server network' }));
    await vi.waitFor(() =>
      expect(findInstalledPlugin(pkg.manifest.id)?.permissions.network).toBe(false),
    );
    await vi.waitFor(() => expect(screen.queryByText('Working…')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(screen.getByRole('textbox', { name: 'Server URL' })).toBeTruthy();
    expect(screen.getByLabelText('Auth Key')).toHaveProperty('type', 'password');
    await page.screenshot({ path: __PLUGIN_TEST_ARTIFACTS__ + '/plugin-connection-en.png' });
  });
  it('renders Chinese labels and bordered actions in electronic ink mode', async () => {
    locale.language = 'zh-CN';
    document.documentElement.dataset['eink'] = 'true';
    mount();
    await vi.waitFor(() => expect(screen.queryByText(zh['Working…'])).toBeNull());
    expect(screen.getByRole('tab', { name: zh['Plugin repositories'] })).toBeTruthy();
    const install = screen.getByRole('button', { name: zh['Install from file'] });
    expect(getComputedStyle(install).borderTopWidth).toBe('1px');
    // Tailwind represents a disabled shadow as transparent zero-size layers.
    expect(getComputedStyle(install).boxShadow).not.toMatch(/[1-9]\d*px/);
    await page.screenshot({ path: __PLUGIN_TEST_ARTIFACTS__ + '/plugin-manager-zh-eink.png' });
  });
});
