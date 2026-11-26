import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #znabmb8n, a GUARD (not a fail-first): links to a page not created yet stay
 * dashed when a big graph is zoomed in. Chrome strokes a dashed path in one go
 * and, past ~1-2 M dash intervals, silently strokes it solid: a synthetic page
 * showed one path of 4,000 long dashed segments stroked solid at every zoom
 * (1,000 still dashed; `scripts/perf/zz-znab-dashcap.mjs`, task thread), and on
 * the 10k perf vault zoomed in ~4.6× main drew its ghost links solid. The link
 * picture now cuts every link to the view before pathing it, so its dashed path
 * holds only on-screen lengths. This vault (20 missing pages linked from notes
 * all over the graph, so long dashed links) did NOT cross the cap on main
 * (it passes there too); it guards that the cut keeps the dashes, and would
 * catch a change that brings back one huge dashed path at this size or less.
 */
const NOTES = 5_200; // over STREAM_MAX_NODES; each note links to two of 20 missing pages
const MISSING = 20;

test.afterEach(async ({ request }) => {
  await fs.rm(path.join(E2E_VAULT, 'Dash'), { recursive: true, force: true });
  await expect
    .poll(async () => (await api.listPages(request)).some((meta) => meta.id.startsWith('Dash/')), { timeout: 60_000 })
    .toBe(false);
});

async function writeVault(request: APIRequestContext): Promise<void> {
  await fs.mkdir(path.join(E2E_VAULT, 'Dash'), { recursive: true });
  for (let i = 0; i < NOTES; i += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, NOTES - i) }, (_, j) => {
        const n = i + j;
        const base = Math.floor(n / 20) * 20;
        const body = `See [[Dot ${base + ((n - base + 1) % 20)}]], [[Unwritten ${n % MISSING}]] and [[Unwritten ${(n * 7 + 3) % MISSING}]].\n`;
        return fs.writeFile(path.join(E2E_VAULT, 'Dash', `Dot ${n}.md`), body);
      }),
    );
  }
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Dash/')).length, { timeout: 120_000 })
    .toBe(NOTES);
  await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).headers()['x-gumply-syncing'] ?? 'off', { timeout: 30_000 }).toBe('off');
}

interface ProbeNode {
  id: string;
  x: number;
  y: number;
  r: number;
}

const probeNodes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gumplyGraphs: Record<string, { nodes: () => ProbeNode[] }> }).__gumplyGraphs['graph-canvas']!.nodes());

test('guard: ghost links stay dashed when a big graph is zoomed in 8×', async ({ page, request }) => {
  test.setTimeout(420_000);
  await writeVault(request);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await canvas.waitFor({ state: 'attached', timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-layout', 'worker', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 300_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');
  await page.waitForTimeout(2_000);
  const box = (await canvas.boundingBox())!;

  // 8× about the centre (d3-zoom: ×2 per 500 of wheel delta), then rest with the pointer off every node.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i += 1) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(400);
  }
  await page.mouse.move(box.x + 2, box.y + 2);
  await page.waitForTimeout(3_000);

  // A ghost link crossing the view: from the graph's unresolved list and the probe's screen positions.
  const graph = (await (await request.get(`${API_URL}/api/graph`)).json()) as { unresolved: Array<{ source: string; targetTitle: string }> };
  const nodes = await probeNodes(page);
  const at = new Map(nodes.map((node) => [node.id, node]));
  const inView = (x: number, y: number) => x >= 0 && y >= 0 && x < box.width && y < box.height;
  let pick: { from: ProbeNode; to: ProbeNode } | null = null;
  for (const pair of graph.unresolved) {
    const from = at.get(pair.source);
    const to = at.get(`ghost:${pair.targetTitle.trim().toLowerCase()}`);
    if (!from || !to) continue;
    // Its middle on screen, long across the view.
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    if (!inView(mx, my) || Math.hypot(to.x - from.x, to.y - from.y) < 600) continue;
    pick = { from, to };
    break;
  }
  expect(pick, 'a ghost link crossing the zoomed view').not.toBeNull();

  // Sample the canvas's own pixels (alpha: the canvas is transparent where nothing is drawn) along the visible part of
  // that link, away from any dot, and count where ink starts or stops.
  const { transitions, samples } = await page.evaluate(({ from, to, dots, width, height }) => {
    const el = document.querySelector('[data-testid="graph-canvas"] canvas') as HTMLCanvasElement;
    const ratio = el.width / width;
    const ctx = el.getContext('2d')!;
    const image = ctx.getImageData(0, 0, el.width, el.height).data;
    let count = 0;
    let edges = 0;
    let previous: boolean | null = null;
    for (let s = 0; s <= 2000; s += 1) {
      const x = from.x + ((to.x - from.x) * s) / 2000;
      const y = from.y + ((to.y - from.y) * s) / 2000;
      if (x < 4 || y < 4 || x > width - 4 || y > height - 4) continue;
      if (dots.some((d) => Math.hypot(d.x - x, d.y - y) < d.r + 4)) {
        previous = null;
        continue;
      }
      const alpha = image[(Math.round(y * ratio) * el.width + Math.round(x * ratio)) * 4 + 3]!;
      const inked = alpha > 8;
      if (previous !== null && inked !== previous) edges += 1;
      previous = inked;
      count += 1;
    }
    return { transitions: edges, samples: count };
  }, { from: pick!.from, to: pick!.to, dots: nodes.filter((node) => inView(node.x, node.y)), width: box.width, height: box.height });

  test.info().annotations.push({ type: 'dashes', description: `${transitions} ink edges over ${samples} samples along ${pick!.from.id} → ${pick!.to.id}` });
  expect(samples).toBeGreaterThan(100);
  // Dashed: the ink comes and goes every few pixels (a 7-unit period at this zoom). Solid: next to no edges.
  expect(transitions).toBeGreaterThan(20);
});
