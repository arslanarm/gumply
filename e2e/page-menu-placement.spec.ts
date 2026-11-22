import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #sjts42ue: the sidebar row ⋯ menu is 240–320 px wide with one line per item,
 * grouped like Notion, and is never under the Tags/Graph/Trash footer or off
 * screen: it flips up or scrolls, by ⋯, right-click and keyboard alike.
 * Russian, whose labels are the longest.
 */

const LAST = 'Страница 30';
const titles = Array.from({ length: 30 }, (_, i) => `Страница ${String(i + 1).padStart(2, '0')}`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
});

async function seedMany(vault: { seed(pages: Array<{ title: string; content: string }>): Promise<unknown> }) {
  await vault.seed(titles.map((title) => ({ title, content: 'x' })));
}

/**
 * The menu opens with a scale pop-in (`soft-pop`): box geometry read mid-way
 * is a little smaller. Every geometry check waits for its animations first.
 */
async function settled(menu: Locator): Promise<void> {
  await menu.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished)));
}

/** Fully inside the viewport. */
async function expectOnScreen(page: Page, locator: Locator): Promise<void> {
  const box = (await locator.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
}

/** The element at a point is `locator` itself (or inside it): nothing covers it. */
async function expectOnTop(page: Page, locator: Locator): Promise<void> {
  const box = (await locator.boundingBox())!;
  const covered = await locator.evaluate((el, at) => {
    const hit = document.elementFromPoint(at.x, at.y);
    return !(hit && (hit === el || el.contains(hit)));
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  expect(covered).toBe(false);
}

async function openLastRowMenu(page: Page): Promise<Locator> {
  const row = page.getByTestId(`page-item-${LAST}`);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await page.getByTestId(`page-menu-button-${LAST}`).click();
  const menu = page.getByTestId(`page-menu-${LAST}`);
  await expect(menu).toBeVisible();
  await settled(menu);
  return menu;
}

for (const height of [820, 600]) {
  test.describe(`1280×${height}`, () => {
    test.use({ viewport: { width: 1280, height } });

    test('⋯ on the last row: every item visible, one line each, Delete reachable and clickable', async ({ page, vault }) => {
      await seedMany(vault);
      await page.goto('/');
      const menu = await openLastRowMenu(page);
      const remove = page.getByTestId(`delete-page-${LAST}`);
      await expect(remove).toHaveText('Удалить страницу');
      await expectOnScreen(page, menu);
      await expectOnScreen(page, remove);
      await expectOnTop(page, remove);

      // About 240 px (wider when a label needs it, up to 320), no label wraps
      // (every item is one line high) and none is cut with an ellipsis.
      // offsetWidth: layout width, unaffected by the pop-in transform.
      const width = await menu.evaluate((el) => (el as HTMLElement).offsetWidth);
      expect(width).toBeGreaterThanOrEqual(240);
      expect(width).toBeLessThanOrEqual(320);
      const clipped = await menu.getByRole('menuitem').evaluateAll((items) => items.filter((item) => item.scrollWidth > item.clientWidth).length);
      expect(clipped).toBe(0);
      const heights = await menu.getByRole('menuitem').evaluateAll((items) => items.map((item) => (item as HTMLElement).offsetHeight));
      expect(new Set(heights.map((value) => Math.round(value))).size).toBe(1);
      expect(heights[0]!).toBeLessThan(40);
      // Notion-style groups: edit / add inside / import-export / delete.
      await expect(menu.getByRole('separator')).toHaveCount(3);

      await remove.click();
      await expect(page.getByTestId(`page-item-${LAST}`)).toHaveCount(0);
    });

    test('right-click near the bottom flips the menu up; the keyboard reaches the last item', async ({ page, vault }) => {
      await seedMany(vault);
      await page.goto('/');
      await expect(page.getByTestId('editor-content')).toBeVisible();
      const row = page.getByTestId(`page-item-${LAST}`);
      // Playwright scrolls the row into view and waits for it to be stable first.
      await row.click({ button: 'right', position: { x: 40, y: 10 } });
      const menu = page.getByTestId(`page-menu-${LAST}`);
      await expect(menu).toBeVisible();
      await settled(menu);
      await expectOnScreen(page, menu);
      await expectOnTop(page, page.getByTestId(`delete-page-${LAST}`));
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();

      await row.focus();
      await page.keyboard.press('Shift+F10');
      await expect(page.getByTestId(`rename-page-${LAST}`)).toBeFocused();
      await settled(menu);
      await page.keyboard.press('End');
      const remove = page.getByTestId(`delete-page-${LAST}`);
      await expect(remove).toBeFocused();
      await expectOnScreen(page, remove);
      await page.keyboard.press('Home');
      await expect(page.getByTestId(`rename-page-${LAST}`)).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(remove).toBeFocused();
    });
  });
}

test('Escape closes a ⋯ menu and puts focus back on the ⋯ button', async ({ page, vault }) => {
  await seedMany(vault);
  await page.goto('/');
  const menu = await openLastRowMenu(page);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(page.getByTestId(`page-menu-button-${LAST}`)).toBeFocused();
});

test('a click on an item works even though the menu lives outside the sidebar (portal)', async ({ page, vault }) => {
  await seedMany(vault);
  await page.goto('/');
  await openLastRowMenu(page);
  await page.getByTestId(`rename-page-${LAST}`).click();
  await expect(page.getByTestId(`page-menu-${LAST}`)).toBeHidden();
  await expect(page.getByTestId(`page-rename-input-${LAST}`)).toBeFocused();
});

test.describe('narrow layout', () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test('with the sidebar overlay open, the menu sits above the scrim and the footer', async ({ page, vault }) => {
    await seedMany(vault);
    await page.goto('/');
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('sidebar-scrim')).toBeVisible();
    const menu = await openLastRowMenu(page);
    await expectOnScreen(page, menu);
    for (const item of await menu.getByRole('menuitem').all()) await expectOnTop(page, item);
  });
});
