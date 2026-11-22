import { expect, test } from './fixtures';

/**
 * v0.8 D1: Ctrl/Cmd+Shift+O toggles the outline, also while typing, and the
 * app's handler wins over the browser's default (Firefox uses it for the
 * Library). Runs in Chromium and Firefox (playwright.config.ts). Ctrl/Cmd+Alt+O
 * is the fallback.
 */
test('Ctrl/Cmd+Shift+O toggles the outline and the browser default is prevented; Ctrl/Cmd+Alt+O too', async ({ page, vault }) => {
  await vault.seed([{ title: 'Inbox', content: '# Heading\n\nStart' }]);
  await page.goto('/#/Inbox');
  await page.getByTestId('editor-content').getByText('Start', { exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __shortcut: boolean | null }).__shortcut = null;
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyO') (window as unknown as { __shortcut: boolean }).__shortcut = event.defaultPrevented;
    });
  });
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+Shift+O`);
  await expect(page.getByTestId('right-panel-tab-outline')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('outline-item')).toHaveText(['Heading']);
  expect(await page.evaluate(() => (window as unknown as { __shortcut: boolean | null }).__shortcut)).toBe(true);
  await page.keyboard.press(`${modifier}+Shift+O`);
  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  await page.keyboard.press(`${modifier}+Alt+O`);
  await expect(page.getByTestId('right-panel-tab-outline')).toHaveAttribute('aria-selected', 'true');
});
