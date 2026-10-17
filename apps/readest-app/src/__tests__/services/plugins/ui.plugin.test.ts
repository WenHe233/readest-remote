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
const { default: Dialog } = await import('@/components/Dialog');
const { usePluginInbox } = await import('@/services/plugins/inbox');
const { verifyPluginPackage } = await import('@/services/plugins/package');
const { findInstalledPlugin, uninstallPlugin } = await import('@/services/plugins/manager');
await import('@/styles/globals.css');
declare const __PLUGIN_TEST_PACKAGES__: Record<string, string>;
declare const __PLUGIN_TEST_ARTIFACTS__: string;
afterEach(() => {
  cleanup();
  usePluginInbox.setState({ candidate: undefined });
  delete document.documentElement.dataset['eink'];
  document.documentElement.style.fontSize = '';
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
  it.each([
    320, 375, 390, 430, 844,
  ])('keeps plugin controls and nested dialogs inside a %ipx viewport', async (width) => {
    locale.language = 'zh-CN';
    await page.viewport(width, width === 844 ? 390 : 844);
    document.documentElement.style.fontSize = width === 430 ? '20px' : '16px';
    const pkg = await verifyPluginPackage(
      Uint8Array.from(atob(__PLUGIN_TEST_PACKAGES__['kavita']!), (c) => c.charCodeAt(0)),
    );
    const { installPlugin } = await import('@/services/plugins/manager');
    await installPlugin(pkg, true);
    render(
      createElement(Dialog, {
        isOpen: true,
        snapHeight: 0.7,
        title: 'Settings',
        onClose: () => {},
        // biome-ignore lint/correctness/noChildrenProp: Dialog requires children in its createElement props.
        children: createElement(PluginsPanel),
      }),
    );
    await vi.waitFor(() => expect(screen.queryByText(zh['Working…'])).toBeNull());
    const manage = screen.getByText(zh['Manage plugin']);
    manage.scrollIntoView();
    const label = manage.getBoundingClientRect();
    expect(label.width).toBeGreaterThan(50);
    expect(label.height).toBeLessThan(45);
    for (const control of document.querySelectorAll('button, input, select')) {
      const rect = control.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      expect(rect.left).toBeGreaterThanOrEqual(-1);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth + 1);
    }
    fireEvent.click(screen.getByRole('tab', { name: zh['Browse plugins'] }));
    const category = screen.getByText(zh['Category']);
    expect(category.getBoundingClientRect().height).toBeLessThan(40);
    usePluginInbox.setState({ candidate: pkg });
    await vi.waitFor(() =>
      expect(screen.getByRole('dialog', { name: zh['Install plugin'] })).toBeTruthy(),
    );
    const install = screen.getByRole('dialog', { name: zh['Install plugin'] });
    expect(screen.getByRole('dialog', { name: 'Settings' }).contains(install)).toBe(false);
    expect(install.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(install.getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    const installedButton = Array.from(install.querySelectorAll('button')).find(
      (b) => b.textContent === zh['Installed'],
    );
    expect(installedButton?.disabled).toBe(true);
    await page.screenshot({ path: __PLUGIN_TEST_ARTIFACTS__ + `/plugin-mobile-${width}.png` });
  });
  it('reviews a real signature and permissions, installs, revokes network and opens the connection form', async () => {
    await page.viewport(1280, 900);
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
