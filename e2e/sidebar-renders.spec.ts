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
// The dev build runs React's StrictMode, which renders every component twice: a changed row
// counts 2. Main renders all 300 rows several times per step (~1,200); these bounds allow a few rows.
const FEW_ROWS = 12;

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
    expect(await renders(page)).toBeLessThanOrEqual(FEW_ROWS);
  });

  test('going to the graph renders a handful of rows at most', async ({ page }) => {
    await resetRenders(page);
    await page.getByTestId('sidebar-graph').click();
    await expect(page).toHaveURL(/#graph/);
    await page.waitForTimeout(500);
    expect(await renders(page)).toBeLessThanOrEqual(FEW_ROWS);
  });

  test('a page added outside renders its own row and its folder, not every row', async ({ page }) => {
    await resetRenders(page);
    writeFileSync(path.join(E2E_VAULT, 'Big', 'Item new.md'), 'New\n');
    await expect(page.getByTestId('page-item-Big/Item new')).toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(500);
    expect(await renders(page)).toBeLessThanOrEqual(FEW_ROWS + 8);
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

  test('renaming: fast typing, typing mid-word and an IME-style commit all land, character for character', async ({ page }) => {
    // The rename text reaches the row through the store (keystroke → Sidebar → store → row):
    // nothing may be dropped, reordered or jump the caret (@opus-editor's review).
    const row = page.getByTestId('page-item-Big/Item 009');
    await row.hover();
    await page.getByTestId('page-menu-button-Big/Item 009').click();
    await page.getByTestId('rename-page-Big/Item 009').click();
    const input = page.getByTestId('page-rename-input-Big/Item 009');
    await expect(input).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await input.pressSequentially('abcdefghijklmnopqrstuvwxyz0123', { delay: 0 });
    for (let step = 0; step < 10; step += 1) await page.keyboard.press('ArrowLeft');
    await input.pressSequentially('MID', { delay: 0 });
    await page.keyboard.press('End');
    await input.pressSequentially(' щука-ёлка', { delay: 0 });
    await page.keyboard.insertText(' ёжик и чай');
    await expect(input).toHaveValue('abcdefghijklmnopqrstMIDuvwxyz0123 щука-ёлка ёжик и чай');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('page-item-Big/abcdefghijklmnopqrstMIDuvwxyz0123 щука-ёлка ёжик и чай')).toBeAttached({ timeout: 10_000 });
  });
});
