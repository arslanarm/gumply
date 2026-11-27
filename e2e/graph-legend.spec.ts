import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #yy347xgi branch B, from #m5hjtty8's hunt: the legend starts closed on a narrow graph and keeps the user's choice
 * (2); it explains tag nodes (5), grey pages (11) and the current page's ring (12); the local graph says what its
 * 1 / 2 are (7) and has zoom and Fit (8); the subtitle's parts don't split across lines (15). Synthetic vault.
 */

const seedVault = (vault: { seed: (pages: Array<{ title: string; content?: string }>) => Promise<unknown> }) =>
  vault.seed([
    { title: 'Hub', content: 'See [[Plan]] and [[Someday]]. #work' },
    { title: 'Plan', content: 'Back to [[Hub]]. #work' },
    { title: 'Loose', content: 'No tag, no links.' },
  ]);

async function openGraph(page: Page) {
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
}

test('#yy347xgi (2): the legend starts closed on a narrow graph, open on a wide one, and keeps the user\'s choice', async ({ page, vault }) => {
  await seedVault(vault);
  await page.setViewportSize({ width: 800, height: 700 });
  await page.goto('/');
  await openGraph(page);
  await expect(page.getByTestId('graph-legend')).toHaveCount(0);
  await page.setViewportSize({ width: 1500, height: 800 });
  await expect(page.getByTestId('graph-legend')).toBeVisible();
  // The user's choice wins from then on, at any width.
  await page.getByRole('button', { name: 'Legend' }).click();
  await expect(page.getByTestId('graph-legend')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('graph-legend')).toHaveCount(0);
});

test('#yy347xgi (5, 11, 12, 15): the legend explains tag nodes, grey pages and the current page\'s ring; the subtitle keeps its parts whole', async ({ page, vault }) => {
  await seedVault(vault);
  await page.setViewportSize({ width: 1500, height: 800 });
  // Arriving from a page: that page is ringed, and the legend says so.
  await page.goto('/#/Hub');
  await openGraph(page);
  const legend = page.getByTestId('graph-legend');
  await expect(legend.getByTestId('graph-legend-current')).toHaveText(/Current page/);
  await expect(legend.getByTestId('graph-legend-no-tag')).toHaveText(/No tag/);
  await expect(legend.getByTestId('graph-legend-tag-node')).toHaveCount(0);
  await page.getByTestId('graph-panel-toggle').click();
  await page.getByTestId('graph-filter-showTags').click();
  await page.getByTestId('graph-panel-toggle').click();
  await expect(legend.getByTestId('graph-legend-tag-node')).toHaveText(/Tag/);
  // Each subtitle part stays on one line.
  const parts = page.getByTestId('graph-subtitle').locator('.graph-subtitle-part');
  await expect(parts).toHaveCount(3);
  expect(await parts.evaluateAll((spans) => spans.every((span) => getComputedStyle(span).whiteSpace === 'nowrap'))).toBe(true);
});

test('#yy347xgi (7, 8): the local graph labels its depth and has zoom and Fit', async ({ page, vault }) => {
  await seedVault(vault);
  await page.goto('/#/Hub');
  await page.getByTestId('local-graph-toggle').click();
  const local = page.getByTestId('local-graph');
  await expect(local.getByText('Depth', { exact: true })).toBeVisible();
  await expect(local.getByTestId('local-graph-canvas')).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  await expect(local.getByTestId('graph-zoom-in')).toBeVisible();
  await local.getByTestId('graph-fit').click();
  await expect(local.getByTestId('local-graph-canvas')).toHaveAttribute('data-graph-fit-reason', 'button');
});
