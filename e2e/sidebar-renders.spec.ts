import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #8gudbajp: with a big folder expanded, the sidebar re-renders only the rows whose data changed.
 * Every row used to render again on any route change, on each page-list refresh and on each
 * keystroke of a rename (they all got the selected id, the whole page list and the rename text),
 * which in a 5,200-page vault froze the app for seconds. The dev build counts row renders.
 */
const ROWS = 300;

const renders = (page: Page) => page.evaluate(() => (window as unknown as { __gumplyRowRenders?: number }).__gumplyRowRenders ?? 0);
const resetRenders = (page: Page) => page.evaluate(() => ((window as unknown as { __gumplyRowRenders?: number }).__gumplyRowRenders = 0));

test.describe('the sidebar renders only the rows that changed (#8gudbajp)', () => {
  test.beforeEach(async ({ page, vault }) => {
    test.setTimeout(90_000);
    await vault.seed([{ title: 'Anchor' }]);
    const big = path.join(E2E_VAULT, 'Big');
    mkdirSync(big, { recursive: true });
    for (let index = 0; index < ROWS; index += 1) {
      writeFileSync(path.join(big, `Item ${String(index).padStart(3, '0')}.md`), `Item ${index}\n`);
    }
    await expect
      .poll(async () => (await page.request.get(`${API_URL}/api/pages/${encodeURIComponent('Big/Item 000')}`)).status(), { timeout: 30_000 })
      .toBe(200);
    // Opening a page inside reveals (expands) its folder: all its rows are in the tree.
    await page.goto('/#/Big/Item 000');
    await expectPageTitle(page, 'Item 000');
    await expect(page.getByTestId(`page-item-Big/Item ${String(ROWS - 1).padStart(3, '0')}`)).toBeAttached({ timeout: 20_000 });
    await page.waitForTimeout(2_500); // let the first polls settle
  });

  test('opening another page renders the two rows whose selection changed, not the folder', async ({ page }) => {
    await resetRenders(page);
    await page.getByTestId('page-item-Big/Item 005').click();
    await expectPageTitle(page, 'Item 005');
    await page.waitForTimeout(500);
    expect(await renders(page)).toBeLessThanOrEqual(6);
  });

  test('going to the graph renders a handful of rows at most', async ({ page }) => {
    await resetRenders(page);
    await page.getByTestId('sidebar-graph').click();
    await expect(page).toHaveURL(/#graph/);
    await page.waitForTimeout(500);
    expect(await renders(page)).toBeLessThanOrEqual(6);
  });

  test('a page added outside renders its own row and its folder, not every row', async ({ page }) => {
    await resetRenders(page);
    writeFileSync(path.join(E2E_VAULT, 'Big', 'Item new.md'), 'New\n');
    await expect(page.getByTestId('page-item-Big/Item new')).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(500);
    expect(await renders(page)).toBeLessThanOrEqual(10);
  });

  test('the row menu still opens from the mouse and the keyboard', async ({ page }) => {
    const row = page.getByTestId('page-item-Big/Item 007');
    await row.hover();
    await page.getByTestId('page-menu-button-Big/Item 007').click();
    await expect(page.getByTestId('page-menu-Big/Item 007')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('page-menu-Big/Item 007')).toHaveCount(0);
    await row.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByTestId('page-menu-Big/Item 007')).toBeVisible();
    await expect(page.getByTestId('page-menu-Big/Item 007').getByRole('menuitem').first()).toBeFocused();
  });
});
