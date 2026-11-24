import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * N6 (#9x4duwmg): a graph above 5,000 nodes keeps its settled positions in the
 * browser (IndexedDB). Opening the same graph again shows it laid out at once,
 * with no "Arranging the graph…", and it still works (a click opens the page).
 * A changed graph (a new link) is laid out afresh. Nothing is written into the
 * vault for it.
 */
const NOTES = 5_200; // over STREAM_MAX_NODES (5,000): drawn once, settled

interface ProbeNode {
  id: string;
  x: number;
  y: number;
  r: number;
}

const probe = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gumplyGraphs: Record<string, { nodes: () => ProbeNode[] }> }).__gumplyGraphs['graph-canvas']!.nodes());

/** Open the global graph and record whether "arranging" was ever on, until it's ready. */
async function openGraph(page: Page, timeout: number): Promise<{ arranged: boolean; ms: number }> {
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as { __arranged?: boolean };
    w.__arranged = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="graph-canvas"][data-graph-arranging]')) w.__arranged = true;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-graph-arranging'], childList: true });
  });
  const started = Date.now();
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-layout', 'worker', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');
  const ms = Date.now() - started;
  return { arranged: await page.evaluate(() => (window as unknown as { __arranged?: boolean }).__arranged === true), ms };
}

// The notes are written straight to disk: take them away again, so later specs start from a small vault.
test.afterEach(async ({ request }) => {
  await fs.rm(path.join(E2E_VAULT, 'Big'), { recursive: true, force: true });
  await expect
    .poll(async () => (await api.listPages(request)).some((meta) => meta.id.startsWith('Big/')), { timeout: 60_000 })
    .toBe(false);
});

test('a big graph opened again shows its kept layout at once, and a changed graph arranges afresh', async ({ page, request, vault }) => {
  test.setTimeout(420_000);
  await vault.reset();
  await fs.mkdir(path.join(E2E_VAULT, 'Big'), { recursive: true });
  for (let i = 0; i < NOTES; i += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, NOTES - i) }, (_, j) => {
        const n = i + j;
        const base = Math.floor(n / 20) * 20;
        return fs.writeFile(path.join(E2E_VAULT, 'Big', `Note ${n}.md`), `See [[Note ${base + ((n - base + 1) % 20)}]] and [[Note ${(n + 97) % NOTES}]].\n`);
      }),
    );
  }
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Big/')).length, { timeout: 120_000 })
    .toBe(NOTES);
  await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).headers()['x-gumply-syncing'] ?? 'off', { timeout: 30_000 }).toBe('off');

  // First open: laid out by the worker, behind "Arranging the graph…".
  const first = await openGraph(page, 240_000);
  expect(first.arranged).toBe(true);
  await page.waitForTimeout(800); // the fit tween
  const before = new Map((await probe(page)).map((node) => [node.id, node]));
  expect(before.size).toBeGreaterThanOrEqual(NOTES);

  // Opened again (a reload; the browser keeps the cache): laid out at once.
  const again = await openGraph(page, 15_000);
  expect(again.arranged, 'no "Arranging the graph…" for a graph laid out before').toBe(false);
  await page.waitForTimeout(800);
  const after = await probe(page);
  let moved = 0;
  for (const node of after) {
    const was = before.get(node.id);
    if (!was || Math.hypot(was.x - node.x, was.y - node.y) > 2) moved += 1;
  }
  expect(moved, 'the same positions as the first layout').toBe(0);

  // It still works: a click on a node opens its page. Dots overlap at this size,
  // so click the one with the most room around it, inside the canvas.
  const box = (await page.getByTestId('graph-canvas').boundingBox())!;
  const inside = after.filter((node) => node.x > 20 && node.y > 20 && node.x < box.width - 20 && node.y < box.height - 20);
  const cell = new Map<string, ProbeNode[]>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / 24)},${Math.floor(y / 24)}`;
  for (const node of inside) (cell.get(cellOf(node.x, node.y)) ?? cell.set(cellOf(node.x, node.y), []).get(cellOf(node.x, node.y))!).push(node);
  const room = (node: ProbeNode) => {
    let nearest = 24;
    const [cx, cy] = [Math.floor(node.x / 24), Math.floor(node.y / 24)];
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1)
        for (const other of cell.get(`${cx + dx},${cy + dy}`) ?? []) if (other !== node) nearest = Math.min(nearest, Math.hypot(other.x - node.x, other.y - node.y));
    return nearest;
  };
  const target = inside.reduce((best, node) => (room(node) > room(best) ? node : best));
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await expect.poll(() => decodeURIComponent(page.url()), { timeout: 10_000 }).toContain(`#/${target.id}`);

  // Nothing about the layout went into the vault.
  const gumply = await fs.readdir(path.join(E2E_VAULT, '.gumply')).catch(() => [] as string[]);
  expect(gumply.filter((name) => /layout|graph/i.test(name))).toEqual([]);

  // A new link is a different graph: laid out afresh.
  await fs.writeFile(path.join(E2E_VAULT, 'Big', 'Note 0.md'), 'See [[Note 1]], [[Note 97]] and [[Note 2600]].\n');
  await expect
    .poll(async () => {
      const graph = (await (await request.get(`${API_URL}/api/graph`)).json()) as { links: Array<{ source: string; target: string }> };
      return graph.links.some((link) => link.source === 'Big/Note 0' && link.target === 'Big/Note 2600');
    }, { timeout: 30_000 })
    .toBe(true);
  const changed = await openGraph(page, 240_000);
  expect(changed.arranged).toBe(true);
});
