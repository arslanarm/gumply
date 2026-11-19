import { test, expect } from './fixtures';
import { API_URL } from './support/env';

/**
 * Flow A (pages / sidebar) — see wiki `spec/e2e-tests`.
 * A4 (delete/undo) waits for the D11 server work (trash + restore);
 * A3 (rename link rewrite) waits for D12.
 */
test.describe('pages and sidebar', () => {
  test('auto-opens the first root page and opens a nested page from the tree', async ({
    page,
    vault,
  }) => {
    const [projects] = await vault.seed([{ title: 'Projects' }]);
    const [roadmap] = await vault.seed([{ title: 'Roadmap', parentId: projects.id }]);

    await page.goto('/');

    // P0 A1: a root page opens without a click.
    await expect(page.getByTestId('page-title')).toHaveText('Projects');
    await expect(page.getByTestId('page-item-' + roadmap.id)).toBeVisible();

    await page.getByTestId(`page-item-${roadmap.id}`).click();
    await expect(page.getByTestId('page-title')).toHaveText('Roadmap');
    // Hash routing keeps deep links readable: #/projects/roadmap
    expect(decodeURIComponent(page.url())).toContain(`#/${roadmap.id}`);
  });

  test('creates a page from the sidebar and opens it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('empty-state')).toBeVisible();

    await page.getByTestId('new-page-button').click();

    await expect(page.getByTestId('page-title')).toHaveText('Untitled');
    await expect(page.getByTestId('page-tree').getByText('Untitled')).toBeVisible();
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('autosaves typed content and keeps it after reload', async ({ page, vault, request }) => {
    const [page1] = await vault.seed([{ title: 'Autosave target' }]);

    await page.goto('/');
    await expect(page.getByTestId('page-title')).toHaveText('Autosave target');

    const body = page.getByTestId('editor-content');
    await body.click();
    await page.keyboard.type('Hello autosave');

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });

    // Server has it too, not just the editor buffer.
    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(page1.id)}`)
    ).json();
    expect(saved.content).toContain('Hello autosave');

    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Hello autosave');
  });
});
