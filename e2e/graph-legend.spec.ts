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

test('#yy347xgi (6): a new group takes a colour no tag uses yet, and its query takes the keyboard', async ({ page, vault }) => {
  await seedVault(vault);
  // #home hashes to the palette's first slot (and it's free), the colour a new group took before the fix.
  await vault.seed([{ title: 'Garden', content: 'Beds. #home' }]);
  await page.setViewportSize({ width: 1500, height: 800 });
  await page.goto('/');
  await openGraph(page);
  // The colours the legend's tags are drawn in.
  const tagColours = await page
    .getByTestId('graph-legend-tag')
    .evaluateAll((rows) => rows.map((row) => getComputedStyle(row.querySelector('.graph-legend-dot')!).backgroundColor));
  expect(tagColours.length).toBeGreaterThan(0);
  // The premise: a tag (#home) is drawn in the palette's first colour, the one a new group would take before the
  // fix (@opus-editor: pinned, so the case can't pass on both).
  expect(tagColours).toContain('rgb(47, 95, 143)');
  await page.getByTestId('graph-panel-toggle').click();
  await page.getByTestId('graph-group-add').click();
  const query = page.getByTestId('graph-group-query').last();
  await expect(query).toBeFocused();
  const groupColour = await page.getByTestId('graph-group').last().locator('input[type="color"]').inputValue();
  const asRgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  expect(tagColours).not.toContain(asRgb(groupColour));
});
