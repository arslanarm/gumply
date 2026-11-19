import { test, expect } from './fixtures';

/**
 * Smoke: proves the app boots, the vault API works and the sidebar/editor
 * shell renders. Everything else (flows A-F in wiki `spec/e2e-tests`)
 * builds on this.
 *
 * Selectors here are the `data-testid` contract from that wiki page; if a
 * testid is renamed, update it in one place (here) rather than via CSS paths.
 */
test.describe('app shell', () => {
  test('boots with an empty vault without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto('/');

    await expect(page.getByTestId('sidebar')).toBeVisible();
    await expect(page.getByTestId('editor')).toBeVisible();
    // Empty vault -> a friendly empty state, not a blank screen.
    await expect(page.getByTestId('empty-state')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('lists a page created through the API and opens it', async ({ page, vault }) => {
    const [gumply] = await vault.seed([{ title: 'Gumply', content: 'Hello vault.' }]);

    await page.goto('/');

    // Item testids use the raw PageId, slashes included (`page-item-projects/gumply`);
    // getByTestId matches the attribute value, so that is safe.
    const item = page.getByTestId(`page-item-${gumply.id}`);
    await expect(item).toBeVisible();
    await expect(item).toContainText('Gumply');
    await item.click();

    await expect(page.getByTestId('page-title')).toHaveText('Gumply');
    await expect(page.getByTestId('editor')).toContainText('Hello vault.');
  });
});
