import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #pifuz5zs: on a big graph a hover change used to repaint every link (the links'
 * colour depends on the hovered node), ~1.35 s per change on the 10k vault at 4×.
 * The resting links are now kept as a picture while nothing moves, and a hover
 * draws only the hovered node's own links. Counted, not timed: the canvas's
 * `lineTo` calls (links are the only lines; dots, outlines and ghosts are arcs).
 */
const NOTES = 1_600; // over LAYOUT_WORKER_THRESHOLD (1,500): laid out in the worker

test.afterEach(async ({ request }) => {
  await fs.rm(path.join(E2E_VAULT, 'Hover'), { recursive: true, force: true });
  await expect
    .poll(async () => (await api.listPages(request)).some((meta) => meta.id.startsWith('Hover/')), { timeout: 60_000 })
    .toBe(false);
});

async function writeVault(request: APIRequestContext): Promise<void> {
  await fs.mkdir(path.join(E2E_VAULT, 'Hover'), { recursive: true });
  for (let i = 0; i < NOTES; i += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, NOTES - i) }, (_, j) => {
        const n = i + j;
        const base = Math.floor(n / 20) * 20;
        return fs.writeFile(path.join(E2E_VAULT, 'Hover', `Leaf ${n}.md`), `See [[Leaf ${base + ((n - base + 1) % 20)}]] and [[Leaf ${(n + 97) % NOTES}]].\n`);
      }),
    );
  }
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Hover/')).length, { timeout: 120_000 })
    .toBe(NOTES);
  await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).headers()['x-gumply-syncing'] ?? 'off', { timeout: 30_000 }).toBe('off');
}

interface ProbeNode {
  id: string;
  x: number;
  y: number;
  r: number;
}

const probeHovered = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gumplyGraphs: Record<string, { hovered: () => string | null }> }).__gumplyGraphs['graph-canvas']!.hovered());

const probeNodes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gumplyGraphs: Record<string, { nodes: () => ProbeNode[] }> }).__gumplyGraphs['graph-canvas']!.nodes());

test('a hover change on a big graph draws only the hovered node\'s links, not every link again', async ({ page, request }) => {
  test.setTimeout(240_000);
  await writeVault(request);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await canvas.waitFor({ state: 'attached', timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-layout', 'worker', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 180_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');
  await page.waitForTimeout(2_000); // the fit tween, then the rest

  await page.evaluate(() => {
    const w = window as unknown as { __lines: number };
    w.__lines = 0;
    const proto = CanvasRenderingContext2D.prototype;
    const lineTo = proto.lineTo;
    proto.lineTo = function (this: CanvasRenderingContext2D, x: number, y: number) {
      w.__lines += 1;
      return lineTo.call(this, x, y);
    };
  });
  const lines = () => page.evaluate(() => (window as unknown as { __lines: number }).__lines);
  const reset = () => page.evaluate(() => { (window as unknown as { __lines: number }).__lines = 0; });

  const box = (await canvas.boundingBox())!;
  const nodes = (await probeNodes(page)).filter((node) => node.x > 40 && node.y > 40 && node.x < box.width - 40 && node.y < box.height - 40);
  // Two nodes far enough apart that hovering one can't pick the other.
  const first = nodes[0]!;
  const second = nodes.find((node) => Math.hypot(node.x - first.x, node.y - first.y) > 80)!;
  const hover = async (node: ProbeNode | null) => {
    if (node) await page.mouse.move(box.x + node.x, box.y + node.y);
    else await page.mouse.move(box.x + 8, box.y + box.height - 8);
    await page.waitForTimeout(800);
  };
  const totalLinks = NOTES * 2;

  // The first hover may build the layers; the changes after it must not repaint the resting links.
  await hover(first);
  await page.waitForTimeout(1_500);
  await reset();
  await hover(second);
  const onSecond = await lines();
  // The node meant is the one hovered (not merely "something").
  expect(await probeHovered(page)).toBe(second.id);
  await reset();
  await hover(null);
  const offAgain = await lines();
  expect(await probeHovered(page)).toBeNull();
  test.info().annotations.push({ type: 'lineTo', description: `hover another node: ${onSecond}; hover nothing: ${offAgain} (of ${totalLinks} links)` });

  // A node here has ~4 links (2 out, ~2 in); a few frames may each draw them. Far below every link.
  // The hovered node's own links are drawn live (so a run where nothing got hovered can't pass)…
  expect(onSecond).toBeGreaterThan(0);
  // …and nothing else: far below every link.
  expect(onSecond).toBeLessThan(100);
  expect(offAgain).toBeLessThan(100);
});
