import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, BASE_URL, E2E_VAULT } from './support/env';

/**
 * N6 B (#9x4duwmg): above 5,000 nodes, a full repaint with every link costs
 * seconds per frame at 4× (the links' raster), so the links are hidden while
 * the camera moves (wheel, pan, the zoom buttons) and drawn again shortly after
 * it stops. Counted, not timed: the canvas's `lineTo` calls (links are the only
 * lines; dots, outlines and ghosts are arcs).
 */
const NOTES = 5_200; // over STREAM_MAX_NODES (5,000)

// The notes are written straight to disk: take them away again, so later specs start from a small vault.
test.afterEach(async ({ request }) => {
  await fs.rm(path.join(E2E_VAULT, 'Big'), { recursive: true, force: true });
  await expect
    .poll(async () => (await api.listPages(request)).some((meta) => meta.id.startsWith('Big/')), { timeout: 60_000 })
    .toBe(false);
});

async function writeBigVault(request: APIRequestContext): Promise<void> {
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
}

/** Opens the big graph, waits for it to settle, then counts every lineTo on any 2D context. */
async function openCounted(page: Page) {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-layout', 'worker', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 300_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');
  await page.waitForTimeout(1_500); // the fit tween, and its links drawn again
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
  const reset = () => page.evaluate(() => {
    (window as unknown as { __lines: number }).__lines = 0;
  });
  return { canvas, lines, reset };
}

/** A burst of wheel steps, each closer than the idle delay to the last: no frame may draw a link. */
async function wheelBurst(page: Page, box: { x: number; y: number; width: number; height: number }, steps: number) {
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, i % 2 === 0 ? -100 : 100);
    await page.waitForTimeout(40);
  }
}

test('a big graph hides its links while the camera moves and draws them again after', async ({ page, request, vault }) => {
  test.setTimeout(420_000);
  await vault.reset();
  await writeBigVault(request);
  const { canvas, lines, reset } = await openCounted(page);
  const box = (await canvas.boundingBox())!;

  // The pointer goes there first, and any hover repaint it causes is left out of the count.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1_500);
  await reset();
  await wheelBurst(page, box, 6);
  expect(await lines()).toBe(0);

  // Once the camera rests, the links come back (two per note here).
  await expect.poll(lines, { timeout: 10_000 }).toBeGreaterThan(NOTES);

  // The zoom buttons move the camera too.
  await reset();
  await page.getByTestId('graph-zoom-in').click();
  await page.waitForTimeout(60);
  expect(await lines()).toBe(0);
  await expect.poll(lines, { timeout: 10_000 }).toBeGreaterThan(NOTES);
});

test('frames slower than the idle delay (DPR 2, 4× CPU) still draw no link mid-gesture (B-fix)', async ({ browser, request, vault }) => {
  // A gesture frame at DPR 2 on a slow laptop takes ~1 s. The idle wait used to count from the
  // last input only, so it ran out during a frame, between two wheel steps, and the next frame
  // drew every link. It now starts over at the end of each frame while the camera moves.
  test.setTimeout(600_000);
  await vault.reset();
  await writeBigVault(request);
  const context = await browser.newContext({ baseURL: BASE_URL, deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    const { canvas, lines, reset } = await openCounted(page);
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(1_500);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await reset();
    await wheelBurst(page, box, 6);
    // Each step's frame is now slower than the idle delay: still no link until the camera rests.
    expect(await lines()).toBe(0);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    await expect.poll(lines, { timeout: 30_000 }).toBeGreaterThan(NOTES);
  } finally {
    await context.close();
  }
});
