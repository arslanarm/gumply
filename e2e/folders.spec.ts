import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * D33 (#mf397jyx): folders with no page of their own (every Obsidian vault)
 * show in the sidebar as folder items instead of vanishing.
 */

const exists = (relative: string) =>
  fs.access(path.join(E2E_VAULT, relative)).then(
    () => true,
    () => false,
  );

async function writeVault(files: Record<string, string>) {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(E2E_VAULT, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }
}

/** The Obsidian-style vault from the bug report, plus a page linking into a folder by path. */
async function obsidianVault(request: Parameters<typeof api.listPages>[0]) {
  await writeVault({
    'Work/Ideas.md': 'Work ideas',
    'Home/Ideas.md': 'Home ideas',
    'Recipes/Pancakes.md': 'Pancakes',
    'Recipes/Soup.md': 'Soup',
    'Index.md': 'See [[Work/Ideas]] and [[Home/Ideas|home]].',
  });
  // The vault watcher picks the files up.
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.kind === 'folder').map((meta) => meta.id).sort(), {
      timeout: 10_000,
    })
    .toEqual(['Home', 'Recipes', 'Work']);
}

const row = (page: Page, id: string) => page.getByTestId(`page-item-${id}`);

test.describe('plain folders in the sidebar (D33)', () => {
  test('folders show as collapsed folder rows; their pages sit inside, not at the top level', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await obsidianVault(request);
    await page.goto('/#/Index');
    const sidebar = page.getByTestId('sidebar');
    await expect(row(page, 'Work')).toBeVisible();
    await expect(page.getByTestId('folder-icon-Work')).toBeVisible();
    // Folders first, then pages; folders start collapsed, as in Obsidian.
    await expect(sidebar.locator('[role="treeitem"] .page-item-title')).toHaveText(['Home', 'Recipes', 'Work', 'Index']);
    await expect(row(page, 'Work/Ideas')).toHaveCount(0);

    await row(page, 'Work').click();
    await expect(row(page, 'Work/Ideas')).toBeVisible();
    await expect(page.getByTestId('folder-view-title')).toHaveText('Work');
    await expect(page.getByTestId('folder-item-Work/Ideas')).toContainText('Ideas');
    await row(page, 'Home').click();
    await expect(row(page, 'Home/Ideas')).toBeVisible();
    // Two "Ideas" rows, each under its own folder.
    await expect(row(page, 'Work').locator('xpath=..').getByTestId('page-item-Work/Ideas')).toBeVisible();
    await expect(row(page, 'Home').locator('xpath=..').getByTestId('page-item-Home/Ideas')).toBeVisible();

    // Viewing a folder never writes a file.
    expect(await exists('Work.md')).toBe(false);
    expect(await exists('Home.md')).toBe(false);

    // Clicking the open folder again closes it.
    await row(page, 'Home').click();
    await expect(row(page, 'Home/Ideas')).toHaveCount(0);
  });

  test('the folder view opens items and makes new pages inside the folder', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await obsidianVault(request);
    await page.goto('/#/Recipes');
    await expect(page.getByTestId('folder-view-title')).toHaveText('Recipes');
    await expect(page.getByTestId('folder-view')).toContainText('2 items');
    await page.getByTestId('folder-item-Recipes/Soup').click();
    await expect(page.getByTestId('editor-content')).toContainText('Soup');

    await row(page, 'Recipes').click();
    await page.getByTestId('folder-new-page').click();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('Waffles');
    await page.keyboard.press('Enter');
    await expect.poll(() => exists('Recipes/Waffles.md'), { timeout: 10_000 }).toBe(true);
    const meta = (await api.listPages(request)).find((item) => item.id === 'Recipes/Waffles');
    expect(meta?.parentId).toBe('Recipes');
  });

  test('rename a folder: the directory moves and path links follow', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await obsidianVault(request);
    await page.goto('/#/Index');
    await row(page, 'Work').hover();
    await page.getByTestId('page-menu-button-Work').click();
    await page.getByTestId('rename-page-Work').click();
    const input = page.getByTestId('page-rename-input-Work');
    await expect(input).toBeFocused();
    await page.keyboard.type('Office');
    await page.keyboard.press('Enter');
    // Renaming doesn't open the folder: the page stays open.
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await expect(row(page, 'Office')).toBeVisible();
    await expect.poll(() => exists('Office/Ideas.md')).toBe(true);
    expect(await exists('Work')).toBe(false);
    // The open page was rewritten and reloads with the new link.
    await expect
      .poll(async () => (await api.getPage(request, 'Index')).content)
      .toBe('See [[Office/Ideas]] and [[Home/Ideas|home]].');
    await expect(page.getByTestId('editor-content').getByText('Office/Ideas')).toBeVisible();
  });

  test('delete a folder: confirm counts the pages inside, Undo brings it all back', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await obsidianVault(request);
    await page.goto('/#/Index');
    await row(page, 'Recipes').hover();
    await page.getByTestId('page-menu-button-Recipes').click();
    await expect(page.getByTestId('duplicate-page-Recipes')).toHaveCount(0);
    await page.getByTestId('delete-page-Recipes').click();
    const dialog = page.getByTestId('delete-confirm-dialog');
    await expect(dialog).toContainText('Delete folder “Recipes”?');
    await expect(dialog).toContainText('The 2 pages inside will be deleted too.');
    await page.getByTestId('delete-confirm').click();
    await expect(row(page, 'Recipes')).toHaveCount(0);
    expect(await exists('Recipes')).toBe(false);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(row(page, 'Recipes')).toBeVisible();
    expect(await exists('Recipes/Soup.md')).toBe(true);
  });

  test('drag a page onto a folder moves it there', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await obsidianVault(request);
    await page.goto('/#/Index');
    await row(page, 'Index').dragTo(row(page, 'Work'));
    await expect.poll(() => exists('Work/Index.md'), { timeout: 10_000 }).toBe(true);
    await expect(row(page, 'Work/Index')).toBeVisible();
  });

  test('folders are not search results or link suggestions; opening a page reveals its folder', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await obsidianVault(request);
    await page.goto('/#/Index');
    // Wait for the app: the Ctrl/Cmd+K listener is registered on mount.
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('quick-switcher-input')).toBeFocused();
    const search = page.getByTestId('quick-switcher-input');
    await search.fill('Recipes');
    // Only the "Create" rows mention it: the folder itself is no result.
    await expect(page.getByTestId('quick-switcher')).toContainText('No pages match “Recipes”');
    await search.fill('Pancakes');
    await expect(page.getByTestId('quick-switcher').getByRole('option').first()).toContainText('Pancakes');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('editor-content')).toContainText('Pancakes');
    // The closed folder opened to show where the page lives.
    await expect(row(page, 'Recipes/Pancakes')).toHaveClass(/is-selected/);

    await page.getByTestId('editor-content').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' [[Wor');
    await expect(page.getByTestId('link-menu')).toBeVisible();
    // The folder "Work" is no link target: only "Create “Wor”" is offered.
    await expect(page.getByTestId('link-menu')).toContainText('Create “Wor”');
    await expect(page.getByTestId('link-menu').getByRole('option').filter({ hasText: /^\s*Work\s*$/ })).toHaveCount(0);
  });
});
