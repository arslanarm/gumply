import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * #ecnncm86: opening a page deep in a big folder (by URL, Cmd+K…) brings
 * its row into the sidebar's view; clicking a visible row never moves it.
 */
const ROWS = 2000;
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** The row's box relative to the sidebar's visible area. */
async function rowInView(page: Page, id: string): Promise<boolean> {
  return page.evaluate((target) => {
    const tree = document.querySelector<HTMLElement>('[data-testid="page-tree"]');
    const row = [...document.querySelectorAll<HTMLElement>('[data-page-id]')].find((item) => item.dataset.pageId === target);
    if (!tree || !row) return false;
    const view = tree.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
  }, id);
}

test.describe('the sidebar follows the opened page', () => {
  test.beforeEach(async ({ vault, page }) => {
    test.setTimeout(120_000);
    await vault.seed([{ title: 'Anchor' }]);
    const big = path.join(E2E_VAULT, 'Big');
    mkdirSync(big, { recursive: true });
    for (let index = 0; index < ROWS; index += 1) {
      writeFileSync(path.join(big, `Note ${String(index).padStart(4, '0')}.md`), `Note ${index}\n`);
    }
    await expect
      .poll(async () => (await page.request.get(`${API_URL}/api/pages/${encodeURIComponent('Big/Note 1999')}`)).status(), { timeout: 30_000 })
      .toBe(200);
  });

  test('by URL and by Cmd+K, a row far down scrolls into view', async ({ page }) => {
    await page.goto('/#/Big/Note 1950');
    // #8gudbajp: wait before expecting. An expect on an element that doesn't exist yet snapshots the
    // whole page on every poll (Playwright 1.65); over a big sidebar that holds the page for seconds.
    await page.getByTestId('page-title').first().waitFor({ timeout: 20_000 });
    await expect(page.getByTestId('page-title').first()).toBeVisible({ timeout: 20_000 });
    await expectPageTitle(page, 'Note 1950');
    await expect.poll(() => rowInView(page, 'Big/Note 1950')).toBe(true);

    // Cmd+K to another far row (towards the top this time).
    await page.keyboard.press(`${MOD}+k`);
    await page.keyboard.type('Note 0040');
    await page.getByTestId('quick-switcher').waitFor();
    await expect(page.getByTestId('quick-switcher')).toContainText('Note 0040');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('page-title').first()).toHaveText('Note 0040', { timeout: 20_000 });
    await expect.poll(() => rowInView(page, 'Big/Note 0040')).toBe(true);
  });

  test('clicking a row that is already visible never moves the list', async ({ page }) => {
    await page.goto('/#/Big/Note 1000');
    await page.getByTestId('page-title').first().waitFor({ timeout: 20_000 });
    await expect(page.getByTestId('page-title').first()).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => rowInView(page, 'Big/Note 1000')).toBe(true);
    // Where the row sits on screen (scrollTop itself may shift as chunks
    // above settle to their real height; the browser anchors what's in view).
    const rowTop = () =>
      page.getByTestId('page-item-Big/Note 0997').evaluate((element) => Math.round(element.getBoundingClientRect().top));
    const before = await rowTop();
    // A neighbour a few rows up: "nearest" brought Note 1000 in at the bottom edge.
    await page.getByTestId('page-item-Big/Note 0997').click();
    await expect(page.getByTestId('page-title').first()).toHaveText('Note 0997', { timeout: 20_000 });
    await page.waitForTimeout(300);
    expect(Math.abs((await rowTop()) - before)).toBeLessThanOrEqual(1);
  });
});
