import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #s3sszwux (iii): above 5,000 nodes the links are drawn by GraphCanvas into a
 * CPU canvas (link-layer.ts), not by force-graph. Hovering a node must still
 * draw its links in the accent style, at fit and after zooming in (a slot run
 * found them missing after a zoom). Checked through the dev probe's record of
 * the layer's last draw (links per slot), not pixels.
 */
const NOTES = 5_200; // over STREAM_MAX_NODES (5,000)

type LayerDraw = { slots: number[]; hoveredId: string | null; scale: number } | null;
type Probe = {
  nodes: () => Array<{ id: string; x: number; y: number; r: number }>;
  zoom: () => number;
  hovered: () => string | null;
  linkLayer: () => LayerDraw;
};

/** One probe method's result. */
const probe = <K extends keyof Probe>(page: Page, method: K) =>
  page.evaluate(
    (name) => (window as unknown as { __gumplyGraphs: Record<string, Record<string, () => unknown>> }).__gumplyGraphs['graph-canvas']![name]!(),
    method,
  ) as Promise<ReturnType<Probe[K]>>;

/** Active links (the hovered node's, solid or dashed) in the layer's last draw. */
const activeLinks = (draw: LayerDraw) => (draw ? (draw.slots[2] ?? 0) + (draw.slots[3] ?? 0) : 0);

/** Hover `id` with the real mouse, at its current place on screen. */
async function hover(page: Page, id: string) {
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  const node = (await probe(page, 'nodes')).find((candidate) => candidate.id === id)!;
  await page.mouse.move(box.x + node.x, box.y + node.y);
  await expect.poll(() => probe(page, 'hovered'), { timeout: 10_000 }).toBe(id);
}

test('a big graph draws the hovered node\'s links, at fit and after zooming in', async ({ page, request, vault }) => {
  test.setTimeout(300_000);
  void vault; // resets the vault before and after, so these notes reach no other spec
  await fs.mkdir(path.join(E2E_VAULT, 'Many'), { recursive: true });
  for (let i = 0; i < NOTES; i += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, NOTES - i) }, (_, j) => {
        const n = i + j;
        const base = Math.floor(n / 20) * 20;
        return fs.writeFile(path.join(E2E_VAULT, 'Many', `Note ${n}.md`), `See [[Note ${base + ((n - base + 1) % 20)}]] and [[Note ${(n + 97) % NOTES}]].\n`);
      }),
    );
  }
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Many/')).length, { timeout: 120_000 })
    .toBe(NOTES);
  await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).headers()['x-gumply-syncing'] ?? 'off', { timeout: 30_000 }).toBe('off');

  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 240_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');

  // At rest the layer draws the links itself (idle slots), none active.
  await expect.poll(async () => {
    const draw = await probe(page, 'linkLayer');
    return draw ? (draw.slots[0] ?? 0) + (draw.slots[1] ?? 0) : 0;
  }, { timeout: 15_000 }).toBeGreaterThan(1_000);

  // A node with links, near the middle of the view.
  const nodes = (await probe(page, 'nodes')).filter((node) => node.id.startsWith('Many/'));
  const box0 = (await canvas.boundingBox())!;
  const middle = { x: box0.width / 2, y: box0.height / 2 };
  const target = nodes.sort((a, b) => Math.hypot(a.x - middle.x, a.y - middle.y) - Math.hypot(b.x - middle.x, b.y - middle.y))[0]!.id;

  // At fit: hovering draws its links in the active slot.
  await hover(page, target);
  await expect.poll(async () => {
    const draw = await probe(page, 'linkLayer');
    return draw?.hoveredId === target ? activeLinks(draw) : 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);

  // Zoom in on it (the slot run used 11 wheel steps), then hover it again: still drawn.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await probe(page, 'zoom');
  for (let step = 0; step < 11; step += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(150);
  }
  await expect.poll(() => probe(page, 'zoom'), { timeout: 15_000 }).toBeGreaterThan(before * 2);
  await page.waitForTimeout(500);
  await hover(page, target);
  await expect.poll(async () => {
    const draw = await probe(page, 'linkLayer');
    return draw?.hoveredId === target ? activeLinks(draw) : 0;
  }, { timeout: 15_000 }).toBeGreaterThan(0);
});
