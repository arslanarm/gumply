import { test, expect } from './fixtures';

/**
 * Flow D (graph) — see wiki `spec/e2e-tests`, incl. D16 ghost nodes.
 *
 * Canvas geometry is not stable enough to click individual nodes by pixel, so
 * this file asserts the graph's observable surface (states, counts, aria
 * summary, filters, local panel). Ghost-node *rendering* detail (dashed/hollow,
 * legend, tooltip) is a UX-walkthrough item; clicking a ghost is covered by the
 * graph model's unit tests and by the same create-page path used below.
 */
test.describe('graph', () => {
  test('empty vault shows the empty state instead of a blank canvas', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();

    await expect(page.getByTestId('graph-empty')).toBeVisible();
    await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
  });

  test('renders pages, links and missing pages with a truthful aria summary', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Source', content: 'See [[Target]] and [[Missing Page]].' }]);
    await vault.seed([{ title: 'Target' }]);

    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();

    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toBeVisible();
    // 2 real pages, 2 links (Source->Target + Source->ghost), 1 missing title.
    // The subtitle and aria summary describe the same picture, ghosts included.
    await expect(canvas).toHaveAttribute('aria-label', '2 pages, 2 links, 1 missing');
    await expect(page.getByTestId('graph-subtitle')).toHaveText('2 pages · 2 links · 1 missing');
    await expect(page.getByTestId('graph-legend')).toBeVisible();
  });

  test('filter narrows the graph and shows the filter-empty state', async ({ page, vault }) => {
    await vault.seed([{ title: 'Alpha' }, { title: 'Beta' }]);

    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();

    await page.getByTestId('graph-filter').fill('zzz-no-match');
    await expect(page.getByTestId('graph-filter-empty')).toBeVisible();

    await page.getByTestId('graph-filter').fill('Alp');
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    await expect(page.getByTestId('graph-filter-empty')).toHaveCount(0);
  });

  test('local graph panel opens and shows its empty state for an unlinked page', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Lonely' }]);

    await page.goto('/');
    await expect(page.getByTestId('editor')).toBeVisible();

    await page.getByTestId('local-graph-toggle').click();
    await expect(page.getByTestId('local-graph')).toBeVisible();
    await expect(page.getByTestId('local-graph-empty')).toBeVisible();
  });

  test('local graph renders neighbours for a linked page', async ({ page, vault }) => {
    const [source] = await vault.seed([
      { title: 'Source', content: 'Points at [[Target]].' },
    ]);
    await vault.seed([{ title: 'Target' }]);

    await page.goto('/');
    await page.getByTestId(`page-item-${source.id}`).click();
    await page.getByTestId('local-graph-toggle').click();

    await expect(page.getByTestId('local-graph-canvas')).toBeVisible();
    await expect(page.getByTestId('local-graph-empty')).toHaveCount(0);
  });
});
