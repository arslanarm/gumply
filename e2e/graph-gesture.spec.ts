import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

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

test('a big graph hides its links while the camera moves and draws them again after', async ({ page, request, vault }) => {
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

  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-layout', 'worker', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 240_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');
  await page.waitForTimeout(1_000); // the fit tween, and its links drawn again

  // Count every lineTo on any 2D context from here on.
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
  const box = (await canvas.boundingBox())!;

  // A burst of wheel steps, each closer than the idle delay to the last: no frame draws a link.
  // The pointer goes there first, and any hover repaint it causes is left out of the count.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1_500);
  await page.evaluate(() => {
    (window as unknown as { __lines: number }).__lines = 0;
  });
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, i % 2 === 0 ? -100 : 100);
    await page.waitForTimeout(40);
  }
  expect(await lines()).toBe(0);

  // Once the camera rests, the links come back (two per note here).
  await expect.poll(lines, { timeout: 10_000 }).toBeGreaterThan(NOTES);

  // The zoom buttons move the camera too.
  await page.evaluate(() => {
    (window as unknown as { __lines: number }).__lines = 0;
  });
  await page.getByTestId('graph-zoom-in').click();
  await page.waitForTimeout(60);
  expect(await lines()).toBe(0);
  await expect.poll(lines, { timeout: 10_000 }).toBeGreaterThan(NOTES);
});
