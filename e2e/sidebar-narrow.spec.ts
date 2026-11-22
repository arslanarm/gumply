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
