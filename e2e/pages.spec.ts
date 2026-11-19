import { test, expect } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

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
    await expectPageTitle(page, 'Projects');
    await expect(page.getByTestId('page-item-' + roadmap.id)).toBeVisible();

    await page.getByTestId(`page-item-${roadmap.id}`).click();
    await expectPageTitle(page, 'Roadmap');
    // Hash routing keeps deep links readable: #/projects/roadmap
    expect(decodeURIComponent(page.url())).toContain(`#/${roadmap.id}`);
  });

  test('creates a page from the sidebar and opens it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('empty-state')).toBeVisible();

    await page.getByTestId('new-page-button').click();

    await expectPageTitle(page, 'Untitled');
    await expect(page.getByTestId('page-tree').getByText('Untitled')).toBeVisible();
    await expect(page.getByTestId('editor')).toBeVisible();
  });

  test('autosaves typed content and keeps it after reload', async ({ page, vault, request }) => {
    const [page1] = await vault.seed([{ title: 'Autosave target' }]);

    await page.goto('/');
    await expectPageTitle(page, 'Autosave target');

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

  test('renaming a page rewrites links to it in other pages (D12)', async ({
    page,
    vault,
    request,
  }) => {
    const [source] = await vault.seed([
      { title: 'Source', content: 'See [[Target]] and [[Target|an alias]].' },
    ]);
    const [target] = await vault.seed([{ title: 'Target' }]);

    await page.goto('/');

    // Inline rename from the tree: double-click the row, edit, Enter.
    await page.getByTestId(`page-item-${target.id}`).dblclick();
    const input = page.getByTestId(`page-rename-input-${target.id}`);
    await input.fill('Target Renamed');
    // Keyboard press, not input.press(): Enter commits the rename and detaches
    // the input, and an element-bound press would retry against a dead locator.
    await page.keyboard.press('Enter');

    // Id stays fixed (deep links keep working), only the title changes.
    await expect(page.getByTestId(`page-item-${target.id}`)).toContainText('Target Renamed');

    const saved = await (
      await request.get(`${API_URL}/api/pages/${encodeURIComponent(source.id)}`)
    ).json();
    expect(saved.content).toContain('[[Target Renamed]]');
    expect(saved.content).toContain('[[Target Renamed|an alias]]');

    // Source was auto-opened on load, and an already-open page does not refetch
    // after a rename elsewhere (tracked separately), so reload before asserting
    // what the rewritten markdown renders as.
    await page.getByTestId(`page-item-${source.id}`).click();
    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Target Renamed');
  });
});
