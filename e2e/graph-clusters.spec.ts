import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #xb4b54gr (spec/api-graph-clusters): "Group by" in the graph panel. Groups
 * of pages clearly denser inside than chance get a soft area (counted through
 * the dev probe, since a faint tint isn't a reliable pixel test): clean topics
 * and the tighter parts of a connected web; a vault linked at random gets
 * none and the panel says so; the mode is saved, and only when the user
 * changes it.
 */

const GUMPLY_GRAPH = path.join(E2E_VAULT, '.gumply', 'graph.json');
/** The saved settings, or null before the first (debounced) save. */
const saved = () => (existsSync(GUMPLY_GRAPH) ? (JSON.parse(readFileSync(GUMPLY_GRAPH, 'utf8')) as Record<string, unknown>) : null);
test.beforeEach(() => rmSync(GUMPLY_GRAPH, { force: true }));
test.afterEach(() => rmSync(GUMPLY_GRAPH, { force: true }));

/** Three topics of 8 pages, each page linking 3 others in its topic; one link across. */
function plantedPages(): Array<{ title: string; content: string }> {
  const topics = ['Garden', 'Kitchen', 'Music'];
  const pages: Array<{ title: string; content: string }> = [];
  for (const topic of topics) {
    for (let i = 0; i < 8; i += 1) {
      const links = [1, 2, 3].map((step) => `[[${topic} ${(i + step) % 8}]]`).join(' ');
      pages.push({ title: `${topic} ${i}`, content: `Notes. ${links}${topic === 'Garden' && i === 0 ? ' [[Kitchen 0]]' : ''}` });
    }
  }
  return pages;
}

async function openGraph(page: Page) {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-graph-ready', 'true', { timeout: 30_000 });
}

const groupSizes = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __gumplyGraphs: Record<string, { clusters: () => { sizes: number[] } }> }).__gumplyGraphs['graph-canvas']!.clusters()
        .sizes,
  );

test('linked topics get a group each by default; Off draws none; the choice is saved and survives a reload', async ({ page, vault }) => {
  test.setTimeout(90_000);
  await vault.seed(plantedPages());
  await openGraph(page);
  await expect.poll(() => groupSizes(page)).toEqual([8, 8, 8]);
  // The Legend explains the colours (@lead).
  await expect(page.getByTestId('graph-legend-clusters')).toHaveText('colour area = group of linked pages');

  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-clusters')).toHaveValue('links');
  // Nothing was changed yet: no clusterBy in the file (a newer Gumply's value would be kept).
  await page.getByTestId('graph-filter-showOrphans').click();
  await expect.poll(() => (saved()?.filters as { showOrphans?: boolean } | undefined)?.showOrphans).toBe(false);
  expect(saved()).not.toHaveProperty('clusterBy');

  await page.getByTestId('graph-clusters').selectOption('off');
  await expect.poll(() => groupSizes(page)).toEqual([]);
  await expect(page.getByTestId('graph-legend-clusters')).toHaveCount(0);
  await expect.poll(() => saved()?.clusterBy).toBe('off');

  await page.reload();
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-graph-ready', 'true', { timeout: 30_000 });
  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-clusters')).toHaveValue('off');
  expect(await groupSizes(page)).toEqual([]);
});

test('a vault linked at random has no groups, and the panel says why', async ({ page, vault }) => {
  test.setTimeout(90_000);
  // 40 pages, each linking 12 others drawn by a seeded generator: dense and topic-free,
  // so no group passes the per-cluster rule (checked offline: 0 areas).
  let state = 12345;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pages = Array.from({ length: 40 }, (_, i) => ({
    title: `Note ${i}`,
    content: Array.from({ length: 12 }, () => `[[Note ${Math.floor(next() * 40)}]]`).join(' '),
  }));
  await vault.seed(pages);
  await openGraph(page);
  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-clusters-none')).toBeVisible();
  await expect(page.getByTestId('graph-clusters-none')).toContainText('No clear groups found');
  expect(await groupSizes(page)).toEqual([]);
});

test('a connected web: a tight and a looser topic with links between them and a few stray notes get an area each', async ({ page, vault }) => {
  test.setTimeout(90_000);
  const pages: Array<{ title: string; content: string }> = [];
  for (let i = 0; i < 10; i += 1) pages.push({ title: `Tight ${i}`, content: [1, 2, 3, 4].map((s) => `[[Tight ${(i + s) % 10}]]`).join(' ') });
  for (let i = 0; i < 10; i += 1) {
    const links = [1, 2].map((s) => `[[Loose ${(i + s) % 10}]]`);
    if (i % 3 === 0) links.push(`[[Tight ${i}]]`);
    pages.push({ title: `Loose ${i}`, content: links.join(' ') });
  }
  for (let i = 0; i < 6; i += 1) pages.push({ title: `Stray ${i}`, content: `See [[${i % 2 ? 'Tight' : 'Loose'} ${i}]].` });
  await vault.seed(pages);
  await openGraph(page);
  await expect.poll(async () => (await groupSizes(page)).length).toBe(2);
  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-clusters-none')).toHaveCount(0);
});

test('folder mode groups by folder, in Russian', async ({ page, vault }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await vault.seed(plantedPages());
  await openGraph(page);
  await expect(page.getByTestId('graph-legend-clusters')).toHaveText('цветная подложка — группа связанных страниц');
  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-controls')).toContainText('Группировать по');
  await page.getByTestId('graph-clusters').selectOption('folder');
  // The seeded pages share one folder level (the vault top): no folder group of 3+.
  await expect(page.getByTestId('graph-clusters-none')).toContainText('Групп из 3 и более страниц не найдено');
  // No group found, so the Legend has nothing to explain.
  await expect(page.getByTestId('graph-legend-clusters')).toHaveCount(0);
});
