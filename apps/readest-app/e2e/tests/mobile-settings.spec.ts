import { test, expect } from '../fixtures/base';

test('settings panels remain within phone and landscape viewports', async ({ page, openBook }) => {
  test.setTimeout(240_000);
  const reader = await openBook();
  await reader.openSettings();
  const dialog = page.locator('dialog.modal-open');
  await expect(dialog).toBeVisible();
  for (const language of ['en', 'zh-CN']) {
    await dialog.locator('[data-tab="Language"]').click();
    await dialog
      .locator('[data-setting-id="settings.language.interfaceLanguage"] select')
      .selectOption(language);
    for (const width of [320, 375, 390, 430, 844]) {
      await page.setViewportSize({ width, height: width === 844 ? 390 : 844 });
      await page.evaluate((enlarged) => {
        document.documentElement.style.fontSize = enlarged ? '20px' : '';
      }, width === 430);
      for (const panel of [
        'Plugins',
        'Font',
        'Layout',
        'Theme',
        'Control',
        'Language',
        'Integrations',
        'TTS',
        'Custom',
      ]) {
        await dialog.locator(`[data-tab="${panel}"]`).click();
        await expect(dialog.locator(`[data-tab="${panel}"]`)).toHaveClass(/btn-active/);
        const overflow = await dialog.evaluate((root) => {
          const box = root.querySelector('.modal-box')!.getBoundingClientRect();
          return Array.from(root.querySelectorAll('input, select, button, .settings-row-label'))
            .filter((el) => !el.closest('.dialog-tabs'))
            .flatMap((el) => {
              const rect = el.getBoundingClientRect();
              if (!rect.width || !rect.height || getComputedStyle(el).visibility === 'hidden')
                return [];
              return rect.left < box.left - 1 || rect.right > box.right + 1
                ? [
                    {
                      text: el.textContent?.slice(0, 60),
                      html: el.outerHTML.slice(0, 350),
                      parent: el.parentElement?.className,
                      left: rect.left,
                      right: rect.right,
                    },
                  ]
                : [];
            });
        });
        expect.soft(overflow, `${language}: ${panel} at ${width}px`).toEqual([]);
      }
    }
  }
});
