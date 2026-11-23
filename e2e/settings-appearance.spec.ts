import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { deletePage } from './support/api';
import { API_URL } from './support/env';

/**
 * v0.9 F (#if236h9k): Settings → page font and width, and what opens on
 * startup. Per device (`gumply:*`), never in the vault; they survive a reload.
 */

const openSettings = async (page: Page) => {
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-popover')).toBeVisible();
};

test('font and page width apply to page content only, and survive a reload', async ({ page, vault }) => {
  await vault.seed([{ title: 'Reading', content: 'A paragraph to read.' }]);
  await page.goto('/#/Reading');
  await expect(page.getByTestId('editor-content')).toContainText('A paragraph');
  const pane = page.getByTestId('editor');
  const normalWidth = await pane.evaluate((el) => getComputedStyle(el).maxWidth);
  const sidebarFont = await page.getByTestId('new-page-button').evaluate((el) => getComputedStyle(el).fontFamily);

  await openSettings(page);
  await page.getByTestId('settings-font-serif').click();
  await page.getByTestId('settings-width-wide').click();
  await expect(page.getByTestId('settings-font-serif')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByTestId('editor-content')).toContainText('A paragraph');
  expect(await page.getByTestId('editor-content').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/serif|Georgia|Garamond/i);
  expect(await page.locator('.page-title').first().evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/serif|Georgia|Garamond/i);
  // The interface keeps its own font.
  expect(await page.getByTestId('new-page-button').evaluate((el) => getComputedStyle(el).fontFamily)).toBe(sidebarFont);
  expect(await pane.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('1120px');
  expect(normalWidth).toBe('820px');

  await openSettings(page);
  await expect(page.getByTestId('settings-width-wide')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('settings-width-full').click();
  await page.getByTestId('settings-font-mono').click();
  await expect.poll(() => pane.evaluate((el) => getComputedStyle(el).maxWidth)).toBe('none');
  expect(await page.getByTestId('editor-content').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono|Menlo|Consolas/i);
});

test('on startup: the last opened page, then a chosen page (falling back when it is gone)', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Alpha', content: 'Alpha.' }, { title: 'Beta', content: 'Beta.' }]);
  // Last opened (the default): open Beta, then start again without a page in the URL.
  await page.goto('/#/Beta');
  await expect(page.getByTestId('editor-content')).toContainText('Beta.');
  await page.goto('/');
  await expect(page).toHaveURL(/#\/Beta$/);

  // A page I choose: the picker opens, Alpha is chosen.
  await openSettings(page);
  await page.getByTestId('settings-startup').selectOption('page');
  await expect(page.getByTestId('page-picker')).toBeVisible();
  await page.getByTestId('page-picker-input').fill('alp');
  await page.getByTestId('page-picker-option-Alpha').click();
  await openSettings(page);
  await expect(page.getByTestId('settings-startup')).toHaveValue('page');
  await expect(page.getByTestId('settings-startup-choose')).toContainText('Alpha');
  await page.keyboard.press('Escape');

  await page.goto('/#/Beta');
  await expect(page.getByTestId('editor-content')).toContainText('Beta.');
  await page.goto('/');
  await expect(page).toHaveURL(/#\/Alpha$/);

  // The chosen page is gone: the last opened page instead.
  await page.goto('/#/Beta');
  await expect(page.getByTestId('editor-content')).toContainText('Beta.');
  await deletePage(request, 'Alpha');
  await page.goto('/');
  await expect(page).toHaveURL(/#\/Beta$/);
});

test('on startup: today\'s daily note, made if missing (ru)', async ({ page, vault, request }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await vault.seed([{ title: 'Alpha', content: 'Alpha.' }]);
  await page.goto('/#/Alpha');
  await openSettings(page);
  await expect(page.getByTestId('settings-startup').locator('option[value="daily"]')).toHaveText('Заметку на сегодня');
  await page.getByTestId('settings-startup').selectOption('daily');
  await page.keyboard.press('Escape');

  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`#/.*${today}$`));
  await expect(page.getByTestId(`page-item-Daily/${today}`)).toBeVisible();
  // A second start opens the same note: nothing new is made.
  await page.goto('/');
  await expect(page).toHaveURL(new RegExp(`#/.*${today}$`));
  const pages = (await (await request.get(`${API_URL}/api/pages`)).json()) as Array<{ id: string }>;
  expect(pages.filter((item) => item.id.includes(today)).map((item) => item.id)).toEqual([`Daily/${today}`]);
});
