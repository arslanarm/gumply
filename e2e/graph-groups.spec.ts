import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 E1 (#3gdvjnch, spec/api-graph-groups): the graph's settings panel —
 * colour groups painted on the canvas, the four filters, saving to
 * `.gumply/graph.json`, starting from Obsidian's `graph.json` without ever
 * writing it, and Russian.
 */

const GUMPLY_GRAPH = path.join(E2E_VAULT, '.gumply', 'graph.json');
const OBSIDIAN_GRAPH = path.join(E2E_VAULT, '.obsidian', 'graph.json');
const ATTACHMENT = path.join(E2E_VAULT, 'attachments', 'e1-chart.png');
// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function cleanup() {
  for (const file of [GUMPLY_GRAPH, OBSIDIAN_GRAPH, ATTACHMENT]) rmSync(file, { force: true });
}
test.beforeEach(cleanup);
test.afterEach(cleanup);

async function seed(vault: { seed: (pages: Array<{ title: string; content?: string }>) => Promise<unknown> }) {
  await vault.seed([
    { title: 'Alpha', content: 'Work item #work, links to [[Beta]] and [[Someday]].' },
    { title: 'Beta', content: 'Also #work. Back to [[Alpha]].' },
    { title: 'Gamma', content: 'Home stuff #home.' },
  ]);
}

async function openGraph(page: Page) {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-canvas').locator('canvas')).toBeVisible();
}

/** Canvas pixels within a small distance of `hex` (antialiased edges included). */
async function pixelsOf(page: Page, hex: string): Promise<number> {
  return page.getByTestId('graph-canvas').locator('canvas').evaluate((element, color) => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('2d');
    if (!context) return 0;
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(color.slice(at, at + 2), 16));
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3]! < 200) continue;
      if (Math.abs(data[index]! - r!) + Math.abs(data[index + 1]! - g!) + Math.abs(data[index + 2]! - b!) < 30) count += 1;
    }
    return count;
  }, hex);
}

test('a colour group paints its pages and is saved to .gumply/graph.json', async ({ page, vault }) => {
  test.setTimeout(60_000);
  await seed(vault);
  await openGraph(page);
  const COLOR = '#ff00aa';
  await page.waitForTimeout(1_000);
  expect(await pixelsOf(page, COLOR)).toBe(0);

  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-controls')).toBeVisible();
  await page.getByTestId('graph-group-add').click();
  const row = page.getByTestId('graph-group');
  await row.getByTestId('graph-group-query').fill('tag:#work');
  await row.locator('input[type="color"]').fill(COLOR);
  await expect(page.getByTestId('graph-legend-group')).toContainText('tag:#work');
  await expect.poll(() => pixelsOf(page, COLOR), { timeout: 5_000 }).toBeGreaterThan(20);

  await expect
    .poll(() => (existsSync(GUMPLY_GRAPH) ? JSON.parse(readFileSync(GUMPLY_GRAPH, 'utf8')).groups : null), { timeout: 5_000 })
    .toEqual([{ query: 'tag:#work', color: COLOR }]);

  await page.reload();
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-legend-group')).toContainText('tag:#work');
  await expect.poll(() => pixelsOf(page, COLOR), { timeout: 5_000 }).toBeGreaterThan(20);
});

test('filters: tags, attachments, existing files only, orphans', async ({ page, vault }) => {
  test.setTimeout(60_000);
  mkdirSync(path.dirname(ATTACHMENT), { recursive: true });
  writeFileSync(ATTACHMENT, PNG);
  await seed(vault);
  await vault.seed([{ title: 'Chart note', content: '![[e1-chart.png]]' }]);
  await openGraph(page);
  const subtitle = page.getByTestId('graph-subtitle');
  // Alpha↔Beta (2 links) + Alpha→Someday; Gamma and Chart note have none.
  await expect(subtitle).toHaveText('4 pages · 3 links · 1 missing');

  await page.getByTestId('graph-panel-toggle').click();
  await page.getByTestId('graph-filter-hideUnresolved').check();
  await expect(subtitle).toHaveText('4 pages · 2 links');

  await page.getByTestId('graph-filter-showTags').check();
  // Alpha, Beta → #work; Gamma → #home.
  await expect(subtitle).toHaveText('4 pages · 5 links');

  await page.getByTestId('graph-filter-showTags').uncheck();
  await page.getByTestId('graph-filter-showAttachments').check();
  await expect(subtitle).toHaveText('4 pages · 3 links');
  await expect(page.getByTestId('graph-legend-attachment')).toBeVisible();

  await page.getByTestId('graph-filter-showAttachments').uncheck();
  await page.getByTestId('graph-filter-showOrphans').uncheck();
  await expect(subtitle).toHaveText('2 pages · 2 links');

  await expect
    .poll(() => (existsSync(GUMPLY_GRAPH) ? JSON.parse(readFileSync(GUMPLY_GRAPH, 'utf8')).filters : null), { timeout: 5_000 })
    .toEqual({ search: '', showTags: false, showAttachments: false, hideUnresolved: true, showOrphans: false });
});

test('the search box takes graph queries', async ({ page, vault }) => {
  await seed(vault);
  await openGraph(page);
  await page.getByTestId('graph-filter').fill('tag:#home');
  await expect(page.getByTestId('graph-subtitle')).toHaveText('1 page · 0 links');
  await page.getByTestId('graph-filter').fill('-tag:#home');
  await expect(page.getByTestId('graph-subtitle')).toContainText('2 pages');
});

test("an Obsidian vault starts from its graph.json, which is never written", async ({ page, vault }) => {
  await seed(vault);
  mkdirSync(path.dirname(OBSIDIAN_GRAPH), { recursive: true });
  const obsidian = JSON.stringify({
    'collapse-filter': false,
    search: '',
    showTags: false,
    showAttachments: false,
    hideUnresolved: true,
    showOrphans: true,
    colorGroups: [{ query: 'tag:#home', color: { a: 1, rgb: 3381759 } }],
    scale: 1,
  });
  writeFileSync(OBSIDIAN_GRAPH, obsidian);
  await openGraph(page);
  await expect(page.getByTestId('graph-subtitle')).toHaveText('3 pages · 2 links');
  await expect(page.getByTestId('graph-legend-group')).toContainText('tag:#home');
  await expect.poll(() => pixelsOf(page, '#3399ff'), { timeout: 5_000 }).toBeGreaterThan(20);

  await page.getByTestId('graph-panel-toggle').click();
  await page.getByTestId('graph-filter-hideUnresolved').uncheck();
  await expect.poll(() => existsSync(GUMPLY_GRAPH), { timeout: 5_000 }).toBe(true);
  expect(JSON.parse(readFileSync(GUMPLY_GRAPH, 'utf8'))).toMatchObject({ groups: [{ query: 'tag:#home', color: '#3399ff' }], filters: { hideUnresolved: false } });
  expect(readFileSync(OBSIDIAN_GRAPH, 'utf8')).toBe(obsidian);
});

test('the panel in Russian has no English left', async ({ page, vault }) => {
  await seed(vault);
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await openGraph(page);
  await page.getByTestId('graph-panel-toggle').click();
  await page.getByTestId('graph-group-add').click();
  const panel = page.getByTestId('graph-controls');
  await expect(panel).toContainText('Фильтры');
  await expect(panel).toContainText('Группы');
  const text = (await panel.innerText()).replace(/tag:|path:|file:|OR/g, '');
  expect(text).not.toMatch(/[A-Za-z]{3,}/);
  for (const label of ['Group colour', 'Group query', 'Move up', 'Remove group']) {
    await expect(panel.getByLabel(label)).toHaveCount(0);
  }
});
