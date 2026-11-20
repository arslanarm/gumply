import { expect, test, type Page } from '@playwright/test';

/**
 * Dragging many objects at once (#r6biyzx6). Big selections take a fast path
 * (apps/web/src/board/group-drag.ts): during the drag the objects are only
 * translated on screen, and the positions are committed once on drop. These
 * tests check the outcome is exactly what the normal path gives: everything
 * selected moves by the drag, nothing else moves, connectors stay attached,
 * nothing temporary is left behind, and one undo puts it all back.
 * Speed itself is measured by `scripts/board-perf.mjs`.
 */

interface NodeLike {
  id: string;
  x: number;
  y: number;
}

async function openSeeded(page: Page, seed: number): Promise<void> {
  await page.goto(`/board-lab.html?seed=${seed}&mix=1&id=group-${seed}-${Date.now()}`);
  await page.waitForSelector('.react-flow__node');
  await page.mouse.click(5, 450);
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(500);
}

const positions = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      (window as unknown as { __board: { get: () => { nodes: NodeLike[] } } }).__board
        .get()
        .nodes.map((node) => [node.id, { x: node.x, y: node.y }]),
    ),
  ) as Promise<Record<string, { x: number; y: number }>>;

/** A point on a selected object near the middle, away from links in its text. */
async function grabPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    let best: { x: number; y: number; d: number } | null = null;
    for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node.selected')) {
      const r = el.getBoundingClientRect();
      const x = r.x + 6;
      const y = r.y + 6;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !el.contains(hit) || hit.closest('a, .wiki-link, button')) continue;
      const d = Math.hypot(x - 640, y - 400);
      if (!best || d < best.d) best = { x, y, d };
    }
    if (!best) throw new Error('no selected object to grab');
    return best;
  });
}

async function dragBy(page: Page, dx: number, dy: number): Promise<void> {
  const start = await grabPoint(page);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(start.x + (dx * step) / 10, start.y + (dy * step) / 10);
  }
  await page.mouse.up();
}

async function noTemporaryMoves(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => ({
        translated: [...document.querySelectorAll<HTMLElement>('.react-flow__node')].filter(
          (el) => el.style.translate !== '',
        ).length,
        viewportTranslate: document.querySelector<HTMLElement>('.react-flow__viewport')!.style.translate,
      })),
    )
    .toEqual({ translated: 0, viewportTranslate: '' });
}

/**
 * Connectors whose drawn line does not end at its objects (the path's ends
 * must lie on or next to the two objects' boxes). Throws if it checked fewer
 * than `atLeast` connectors, so the check can't pass by checking nothing.
 */
async function detachedConnectors(page: Page, atLeast: number): Promise<number> {
  const result = await page.evaluate(() => {
    const board = (window as unknown as {
      __board: { get: () => { edges: { id: string; fromNode: string; toNode: string }[] } };
    }).__board.get();
    let checked = 0;
    let detached = 0;
    const box = (id: string) =>
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    for (const edge of board.edges) {
      const path = document.querySelector<SVGPathElement>(
        `.react-flow__edge[data-id="${CSS.escape(edge.id)}"] path.react-flow__edge-path`,
      );
      const from = box(edge.fromNode);
      const to = box(edge.toNode);
      if (!path || !from || !to) continue;
      checked += 1;
      const matrix = path.getScreenCTM()!;
      const at = (t: number) => path.getPointAtLength(t).matrixTransform(matrix);
      const near = (p: DOMPoint, r: DOMRect) =>
        p.x > r.left - 14 && p.x < r.right + 14 && p.y > r.top - 14 && p.y < r.bottom + 14;
      if (!near(at(0), from) || !near(at(path.getTotalLength()), to)) detached += 1;
    }
    return { checked, detached };
  });
  expect(result.checked).toBeGreaterThanOrEqual(atLeast);
  return result.detached;
}

test.describe('board group drag (#r6biyzx6)', () => {
  test('dragging everything moves every object once, keeps connectors attached and undoes in one step', async ({
    page,
  }) => {
    await openSeeded(page, 120);
    const before = await positions(page);
    await page.keyboard.press('Control+a');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(120);

    await dragBy(page, 90, 60);
    await noTemporaryMoves(page);

    const after = await positions(page);
    const deltas = Object.keys(before).map((id) => [after[id]!.x - before[id]!.x, after[id]!.y - before[id]!.y]);
    const [dx, dy] = deltas[0]!;
    expect(Math.abs(dx!)).toBeGreaterThan(50);
    for (const [x, y] of deltas) {
      expect(x).toBeCloseTo(dx!, 3);
      expect(y).toBeCloseTo(dy!, 3);
    }
    expect(await detachedConnectors(page, 40)).toBe(0);

    await page.keyboard.press('Control+z');
    await expect.poll(() => positions(page)).toEqual(before);
  });

  test('dragging a big partial selection moves only it; connectors leaving it stay attached', async ({ page }) => {
    await openSeeded(page, 120);
    const before = await positions(page);
    const points = await page.evaluate(() => {
      const out: { x: number; y: number }[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.react-flow__node')) {
        const r = el.getBoundingClientRect();
        const x = r.x + 6;
        const y = r.y + 6;
        const hit = document.elementFromPoint(x, y);
        if (r.y > 250 && hit && el.contains(hit) && !hit.closest('a, .wiki-link, button')) out.push({ x, y });
        if (out.length >= 40) break;
      }
      return out;
    });
    await page.mouse.click(points[0]!.x, points[0]!.y);
    await page.keyboard.down('Shift');
    for (const point of points.slice(1)) await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Shift');
    const selected = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.react-flow__node.selected')].map((el) => el.dataset.id!),
    );
    expect(selected.length).toBeGreaterThanOrEqual(30);

    // Mid-drag, the connectors already follow the moved objects.
    const start = await grabPoint(page);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(start.x + step * 7, start.y + step * 9);
    expect(await detachedConnectors(page, 40)).toBe(0);
    await page.mouse.up();
    await noTemporaryMoves(page);

    const after = await positions(page);
    const moved = Object.keys(before).filter((id) => after[id]!.x !== before[id]!.x || after[id]!.y !== before[id]!.y);
    expect(new Set(moved)).toEqual(new Set(selected));
    expect(await detachedConnectors(page, 40)).toBe(0);
  });
});
