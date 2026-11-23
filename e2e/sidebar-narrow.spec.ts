import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #hy9dizhb: at <= 900 px the sidebar is an overlay. Every navigation started
 * from it closes it, so the view it opens isn't left under the overlay.
 */

test.use({ viewport: { width: 900, height: 800 } });

async function openSidebar(page: Page): Promise<void> {
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('sidebar-scrim')).toBeVisible();
}

async function expectSidebarClosed(page: Page): Promise<void> {
  await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('sidebar-scrim')).toBeHidden();
  await expect(page.getByTestId('sidebar')).toBeHidden();
}

test.describe('narrow sidebar overlay (#hy9dizhb)', () => {
  test.beforeEach(async ({ page, vault }) => {
    await vault.seed([{ title: 'Note', content: 'Body #project' }]);
    await page.goto('/#/Note');
    await expect(page.getByTestId('editor-content')).toContainText('Body');
    await expect(page.getByTestId('sidebar-toggle')).toHaveAttribute('aria-pressed', 'false');
  });

  test('Trash, Graph and Today close the overlay', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('sidebar-trash').click();
    await expect(page.getByTestId('trash-view')).toBeVisible();
    await expectSidebarClosed(page);

    await openSidebar(page);
    await page.getByTestId('sidebar-graph').click();
    await expect(page).toHaveURL(/#graph$/);
    await expectSidebarClosed(page);

    await openSidebar(page);
    await page.getByTestId('sidebar-today').click();
    await expect(page.getByTestId('page-title').first()).toBeVisible();
    await expectSidebarClosed(page);
  });

  test('Search and a tag in the Tags pane close the overlay', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('sidebar-search').click();
    await expect(page.getByTestId('quick-switcher')).toBeVisible();
    await expectSidebarClosed(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('quick-switcher')).toBeHidden();

    await openSidebar(page);
    const tag = page.getByTestId('tag-open-project');
    if (!(await tag.isVisible())) await page.getByTestId('tags-pane-toggle').click();
    await tag.click();
    await expect(page.getByTestId('quick-switcher-input')).toHaveValue('#project');
    await expectSidebarClosed(page);
  });

  test('New page, New whiteboard and New database view close the overlay', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('new-page-button').click();
    await expect(page.getByTestId('page-title-input')).toBeVisible();
    await expectSidebarClosed(page);

    await openSidebar(page);
    await page.getByTestId('new-board-button').click();
    await expect(page.getByTestId('template-gallery')).toBeVisible();
    await expectSidebarClosed(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('template-gallery')).toBeHidden();

    await openSidebar(page);
    await page.getByTestId('new-base-button').click();
    await expect(page).toHaveURL(/\.base$/);
    await expectSidebarClosed(page);
  });

  test('New from template in a row menu closes the overlay', async ({ page }) => {
    await openSidebar(page);
    await page.getByTestId('page-menu-button-Note').click();
    await page.getByTestId('new-from-template-Note').click();
    await expect(page.getByTestId('template-picker')).toBeVisible();
    await expectSidebarClosed(page);
  });
});

/**
 * #h4tyk92t: the update notice and "Syncing changes…" live in the sidebar. While
 * it's closed, its toggle shows a dot and says why; opening it shows the news.
 */
test.describe('news in a closed sidebar (#h4tyk92t)', () => {
  test('a sync burst: a dot on the toggle, named in its label; gone once open', async ({ page, vault }) => {
    await vault.seed([{ title: 'Note', content: 'Body' }]);
    await page.route(/\/api\/pages(\?.*)?$/, async (route) => {
      try {
        const response = await route.fetch();
        const headers = { ...response.headers(), 'x-gumply-syncing': '1' };
        delete headers['content-length'];
        delete headers['content-encoding'];
        await route.fulfill({ status: response.status(), headers, body: await response.body() });
      } catch {
        // The page closed while the request was in flight.
      }
    });
    await page.goto('/#/Note');
    const toggle = page.getByTestId('sidebar-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('sidebar-toggle-dot')).toHaveAttribute('data-news', 'syncing');
    await expect(toggle).toHaveAccessibleName('Show sidebar: syncing changes');
    await toggle.click();
    await expect(page.getByTestId('sidebar-syncing')).toBeVisible();
    await expect(page.getByTestId('sidebar-toggle-dot')).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName('Hide sidebar');
  });

  test('an update: the dot until Later hides the notice', async ({ page }) => {
    const state = { kind: 'nsis', mode: 'auto', modes: ['auto', 'notify', 'off'], status: 'ready', currentVersion: '0.9.0', version: '0.9.1', releaseUrl: null, lastChecked: null, error: null };
    await page.route('**/api/health', async (route) => {
      try {
        const response = await route.fetch();
        await route.fulfill({ response, json: { ...(await response.json()), desktop: true } });
      } catch {
        // The page closed while the request was in flight.
      }
    });
    await page.route('**/api/desktop/updates**', (route) => route.fulfill({ json: state }));
    await page.goto('/');
    const toggle = page.getByTestId('sidebar-toggle');
    await expect(page.getByTestId('sidebar-toggle-dot')).toHaveAttribute('data-news', 'update');
    await expect(toggle).toHaveAccessibleName('Show sidebar: there’s an update');
    await toggle.click();
    await page.getByTestId('update-notice-later').click();
    await expect(page.getByTestId('update-notice')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('sidebar-toggle-dot')).toHaveCount(0);
    await expect(toggle).toHaveAccessibleName('Show sidebar');
  });
});
