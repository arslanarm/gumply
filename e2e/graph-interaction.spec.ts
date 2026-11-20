import type { Page } from '@playwright/test';
import type { NewPage } from './support/api';
import { test, expect } from './fixtures';

/**
 * #74jpajdy: graph nodes must be easy to grab and the graph must react without
 * lag (owner: "the graph lags, nodes are hard to grab/drag").
 *
 * Node positions come from the dev-only probe `window.__gumplyGraphs[testId]`
 * (GraphCanvas, `import.meta.env.DEV`), in canvas CSS px. Runs in Chromium and
 * Firefox (see the `firefox` project in playwright.config.ts).
 */

const CANVAS = 'graph-canvas';

interface ProbeNode {
  id: string;
  x: number;
  y: number;
  r: number;
}

function fixture(): NewPage[] {
  const pad = (value: number) => String(value).padStart(2, '0');
  const pages: NewPage[] = Array.from({ length: 12 }, (_, index) => {
    const title = `Node ${pad(index)}`;
    const links = [`[[Node ${pad((index + 1) % 12)}]]`, `[[Node ${pad((index + 5) % 12)}]]`];
    if (index === 0) links.push('[[Future Topic]]');
    return { title, content: `# ${title}\n\nRelated: ${links.join(' · ')}\n` };
  });
  // No links: drawn with the smallest radius (4 px), the hardest to grab before.
  pages.push({ title: 'Loner', content: 'No links here.' });
  return pages;
}

async function openGraph(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId(CANVAS);
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  // Let the fit tween finish.
  await page.waitForTimeout(700);
}

async function probeNodes(page: Page): Promise<ProbeNode[]> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as { __gumplyGraphs: Record<string, { nodes: () => ProbeNode[] }> }
      ).__gumplyGraphs[id]!.nodes(),
    CANVAS,
  );
}

async function probeZoom(page: Page): Promise<number> {
  return page.evaluate(
    (id) =>
      (window as unknown as { __gumplyGraphs: Record<string, { zoom: () => number }> })
        .__gumplyGraphs[id]!.zoom(),
    CANVAS,
  );
}

async function nodeByTitle(page: Page, title: string): Promise<ProbeNode> {
  const pages = await page.request.get(`/api/pages`).then((response) => response.json());
  const meta = (pages as Array<{ id: string; title: string }>).find((p) => p.title === title);
  const ghostId = `ghost:${title.toLowerCase()}`;
  const nodes = await probeNodes(page);
  const node = nodes.find((n) => n.id === meta?.id) ?? nodes.find((n) => n.id.toLowerCase() === ghostId);
  if (!node) throw new Error(`no graph node for ${title}: ${nodes.map((n) => n.id).join(', ')}`);
  return node;
}

async function canvasOrigin(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.getByTestId(CANVAS).boundingBox();
  if (!box) throw new Error('graph canvas has no box');
  return { x: box.x, y: box.y };
}

test.describe('graph interaction (#74jpajdy)', () => {
  test('a small node can be grabbed off-centre and dragged, without the camera jumping', async ({
    page,
    vault,
  }) => {
    await vault.seed(fixture());
    await openGraph(page);
    const origin = await canvasOrigin(page);
    const loner = await nodeByTitle(page, 'Loner');
    expect(loner.r).toBeLessThanOrEqual(4.5);
    const before = await probeNodes(page);

    const zoomBefore = await probeZoom(page);
    const fitBefore = await page.getByTestId(CANVAS).getAttribute('data-graph-fit');

    // 11 px from the centre of a 4 px node: outside the old 9 px hit area.
    const start = { x: origin.x + loner.x + 11, y: origin.y + loner.y };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(start.x + step * 10, start.y + step * 6);
    }
    const during = await nodeByTitle(page, 'Loner');
    // The node follows the pointer and keeps the grab offset (no snap).
    expect(Math.abs(during.x - (loner.x + 80))).toBeLessThan(3);
    expect(Math.abs(during.y - (loner.y + 48))).toBeLessThan(3);
    // …and it was a node drag, not a pan: the rest of the graph stayed put.
    const others = (await probeNodes(page)).filter((n) => n.id !== during.id);
    const shifts = others
      .map((n) => {
        const old = before.find((b) => b.id === n.id)!;
        return Math.hypot(n.x - old.x, n.y - old.y);
      })
      .sort((a, b) => a - b);
    expect(shifts[Math.floor(shifts.length / 2)]).toBeLessThan(15);
    await page.mouse.up();

    // After the layout settles the camera stays where the user left it.
    await page.waitForTimeout(3000);
    expect(Math.abs((await probeZoom(page)) - zoomBefore)).toBeLessThan(0.001);
    await expect(page.getByTestId(CANVAS)).toHaveAttribute('data-graph-fit', fitBefore ?? '');
    // A drag is not a click: we are still on the graph.
    await expect(page.getByTestId(CANVAS)).toBeVisible();
  });

  test('hover responds right after zooming and shows the tooltip', async ({ page, vault }) => {
    await vault.seed(fixture());
    await openGraph(page);
    const origin = await canvasOrigin(page);
    const box = await page.getByTestId(CANVAS).boundingBox();

    await page.mouse.move(origin.x + box!.width / 2, origin.y + box!.height / 2);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(80);

    const target = await nodeByTitle(page, 'Node 03');
    await page.mouse.move(origin.x + target.x, origin.y + target.y);
    const tooltip = page.locator('.graph-tooltip');
    // Picking uses live positions: no waiting for a stale hit canvas.
    await expect(tooltip).toBeVisible({ timeout: 300 });
    await expect(tooltip).toContainText('Node 03');

    await page.mouse.move(origin.x + 4, origin.y + 4);
    await expect(tooltip).toBeHidden();
  });

  test('clicking a node opens the page; clicking a ghost creates it', async ({ page, vault }) => {
    await vault.seed(fixture());
    await openGraph(page);
    const origin = await canvasOrigin(page);

    const node = await nodeByTitle(page, 'Node 05');
    await page.mouse.click(origin.x + node.x + 5, origin.y + node.y + 3);
    await expect(page.getByTestId('page-title').first()).toContainText('Node 05');

    await page.getByTestId('sidebar-graph').click();
    await expect(page.getByTestId(CANVAS)).toHaveAttribute('data-graph-ready', 'true', {
      timeout: 15_000,
    });
    await page.waitForTimeout(700);
    const ghost = await nodeByTitle(page, 'Future Topic');
    await page.mouse.click(origin.x + ghost.x, origin.y + ghost.y);
    await expect(page.getByTestId('page-title').first()).toContainText('Future Topic');
  });

  test('dragging empty canvas pans the view instead of moving a node', async ({ page, vault }) => {
    await vault.seed(fixture());
    await openGraph(page);
    const origin = await canvasOrigin(page);
    const box = (await page.getByTestId(CANVAS).boundingBox())!;
    const before = await probeNodes(page);

    // A spot at least 40 px away from every node.
    let spot: { x: number; y: number } | null = null;
    for (let y = 40; y < box.height - 40 && !spot; y += 20) {
      for (let x = 40; x < box.width - 140 && !spot; x += 20) {
        if (before.every((n) => Math.hypot(n.x - x, n.y - y) > 40)) spot = { x, y };
      }
    }
    expect(spot).not.toBeNull();

    await page.mouse.move(origin.x + spot!.x, origin.y + spot!.y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step += 1) {
      await page.mouse.move(origin.x + spot!.x + step * 10, origin.y + spot!.y + step * 5);
    }
    await page.mouse.up();
    await page.waitForTimeout(100);

    const after = await probeNodes(page);
    // Every node shifted with the camera by the same amount (a pan, not a node drag).
    const shifts = after.map((n) => {
      const old = before.find((b) => b.id === n.id)!;
      return { dx: n.x - old.x, dy: n.y - old.y };
    });
    for (const shift of shifts) {
      expect(Math.abs(shift.dx - 60)).toBeLessThan(6);
      expect(Math.abs(shift.dy - 30)).toBeLessThan(6);
    }
  });
});
