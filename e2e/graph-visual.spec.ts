import type { NewPage } from './support/api';
import { test, expect } from './fixtures';

/**
 * Q1b: the graph must really draw, in Chromium *and* Firefox, light and dark
 * (owner: "the graph view doesn't show" / D17, wiki `spec/q1-quality` §Q1b).
 *
 * These tests read the canvas pixels instead of only the aria label: they prove
 * that something was painted, that it is auto-fitted (not clipped, not stuck in
 * a corner), that it re-fits on resize and on "Fit", and that the canvas uses a
 * high-DPI backing store. Run in both browsers via the `firefox` project.
 */

const CANVAS = 'graph-canvas';

interface PixelStats {
  cssWidth: number;
  cssHeight: number;
  backingWidth: number;
  backingHeight: number;
  dpr: number;
  /** Sampled pixels with any paint on them (nodes, links, labels). */
  count: number;
  /** Bounding box of painted pixels, in CSS px. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } | null;
}

async function readCanvas(page: import('@playwright/test').Page, testId = CANVAS): Promise<PixelStats> {
  return page.evaluate((id) => {
    const wrap = document.querySelector(`[data-testid="${id}"]`);
    if (!(wrap instanceof HTMLElement)) throw new Error(`no ${id}`);
    const canvas = wrap.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error(`no canvas in ${id}`);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');

    const rect = canvas.getBoundingClientRect();
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let count = 0;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    // Sample every other device pixel: enough for a bounding box, fast in both
    // browsers even at deviceScaleFactor 2.
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        const alpha = data[(y * canvas.width + x) * 4 + 3] ?? 0;
        if (alpha <= 8) continue;
        count += 1;
        const cssX = x / scaleX;
        const cssY = y / scaleY;
        if (cssX < minX) minX = cssX;
        if (cssX > maxX) maxX = cssX;
        if (cssY < minY) minY = cssY;
        if (cssY > maxY) maxY = cssY;
      }
    }

    return {
      cssWidth: rect.width,
      cssHeight: rect.height,
      backingWidth: canvas.width,
      backingHeight: canvas.height,
      dpr: window.devicePixelRatio,
      count,
      bbox:
        count === 0
          ? null
          : { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY },
    };
  }, testId);
}

/** Twelve-plus linked pages so the layout has a real shape, plus ghost nodes. */
function graphFixture(): NewPage[] {
  const pad = (value: number) => String(value).padStart(2, '0');
  return Array.from({ length: 18 }, (_, index) => {
    const title = `Node ${pad(index)}`;
    const links = [
      `[[Node ${pad((index + 1) % 18)}]]`,
      `[[Node ${pad((index + 5) % 18)}]]`,
    ];
    if (index % 6 === 0) links.push(`[[Future Topic ${index / 6}]]`);
    return { title, content: `# ${title}\n\nRelated: ${links.join(' · ')}\n` };
  });
}

async function openGraph(
  page: import('@playwright/test').Page,
  theme: 'light' | 'dark' = 'light',
): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem('gumply:theme', value);
  }, theme);
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId(CANVAS);
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  // Auto-fit animates for ~300 ms; wait for the tween before sampling pixels.
  await page.waitForTimeout(700);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

function expectDrawnAndFitted(stats: PixelStats): void {
  expect(stats.count).toBeGreaterThan(400);
  expect(stats.bbox).not.toBeNull();
  const box = stats.bbox!;

  const fillX = box.width / stats.cssWidth;
  const fillY = box.height / stats.cssHeight;
  // Auto-fit fills one axis and keeps the other readable — never a corner blob.
  expect(Math.max(fillX, fillY)).toBeGreaterThan(0.5);
  expect(fillX).toBeGreaterThan(0.2);
  expect(fillY).toBeGreaterThan(0.2);

  // Padding is honoured on all four sides: nothing is clipped by the canvas.
  expect(box.minX).toBeGreaterThan(4);
  expect(box.minY).toBeGreaterThan(4);
  expect(stats.cssWidth - box.maxX).toBeGreaterThan(4);
  expect(stats.cssHeight - box.maxY).toBeGreaterThan(4);

  // The drawn graph is centred, not crowded into a corner.
  const centerX = (box.minX + box.maxX) / 2;
  const centerY = (box.minY + box.maxY) / 2;
  expect(Math.abs(centerX - stats.cssWidth / 2)).toBeLessThan(stats.cssWidth * 0.15);
  expect(Math.abs(centerY - stats.cssHeight / 2)).toBeLessThan(stats.cssHeight * 0.15);
}

test.describe('graph pixels', () => {
  test('empty graph uses the calm empty state, with no canvas or dead controls', async ({
    page,
    vault,
  }) => {
    // This test needs a genuinely empty vault: request the fixture so it wipes
    // whatever a previous suite run left behind.
    await vault.reset();
    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();

    await expect(page.getByTestId('graph-empty')).toBeVisible();
    await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
    // Q1d: an empty graph is not a filterable/legend-able surface.
    await expect(page.getByTestId('graph-filter')).toHaveCount(0);
    await expect(page.getByTestId('graph-legend')).toHaveCount(0);
    // Q1d: no dashed placeholder box around the whole pane.
    await expect(page.getByTestId('graph-empty')).not.toHaveCSS('border-style', 'dashed');
  });

  test('auto-fits and paints in light and dark (canvas pixels, not just aria)', async ({
    page,
    vault,
  }) => {
    await vault.seed(graphFixture());

    for (const theme of ['light', 'dark'] as const) {
      await openGraph(page, theme);
      expectDrawnAndFitted(await readCanvas(page));
    }
  });

  test('re-fits on resize instead of clipping or shrinking into a corner', async ({
    page,
    vault,
  }) => {
    await vault.seed(graphFixture());
    await openGraph(page);
    const before = await readCanvas(page);
    expectDrawnAndFitted(before);
    const fitBefore = await page.getByTestId(CANVAS).getAttribute('data-graph-fit');

    await page.setViewportSize({ width: 1080, height: 780 });
    await expect
      .poll(() => page.getByTestId(CANVAS).getAttribute('data-graph-fit'))
      .not.toBe(fitBefore);
    await page.waitForTimeout(700);

    const after = await readCanvas(page);
    expect(after.cssWidth).toBeLessThan(before.cssWidth);
    expectDrawnAndFitted(after);
    // Same fill ratio as before: the graph was re-fitted, not left at its old
    // scale (which would overflow or look tiny on the new canvas).
    const fillBefore = Math.max(before.bbox!.width / before.cssWidth, before.bbox!.height / before.cssHeight);
    const fillAfter = Math.max(after.bbox!.width / after.cssWidth, after.bbox!.height / after.cssHeight);
    expect(Math.abs(fillAfter - fillBefore)).toBeLessThan(0.2);
  });

  test('"Fit" restores the fitted view after zooming in', async ({ page, vault }) => {
    await vault.seed(graphFixture());
    await openGraph(page);
    const before = await readCanvas(page);
    expectDrawnAndFitted(before);
    const fitBefore = await page.getByTestId(CANVAS).getAttribute('data-graph-fit');

    const zoomIn = page.getByTestId('graph-zoom-in');
    await zoomIn.click();
    await zoomIn.click();
    await zoomIn.click();
    await page.waitForTimeout(500);

    await page.getByTestId('graph-fit').click();
    await expect
      .poll(() => page.getByTestId(CANVAS).getAttribute('data-graph-fit'))
      .not.toBe(fitBefore);
    await page.waitForTimeout(700);

    const after = await readCanvas(page);
    expectDrawnAndFitted(after);
    const fillBefore = Math.max(before.bbox!.width / before.cssWidth, before.bbox!.height / before.cssHeight);
    const fillAfter = Math.max(after.bbox!.width / after.cssWidth, after.bbox!.height / after.cssHeight);
    expect(Math.abs(fillAfter - fillBefore)).toBeLessThan(0.2);
  });

  test('re-fits when the title filter changes the graph', async ({ page, vault }) => {
    await vault.seed(graphFixture());
    await openGraph(page);
    const fitBefore = await page.getByTestId(CANVAS).getAttribute('data-graph-fit');
    const canvas = page.getByTestId(CANVAS);

    await page.getByTestId('graph-filter').fill('Node 1');
    await expect.poll(() => canvas.getAttribute('data-graph-fit')).not.toBe(fitBefore);
    await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
    await page.waitForTimeout(700);

    expectDrawnAndFitted(await readCanvas(page));
    // Filtering must not leave the old, larger view zoomed out in the corner.
    await expect(page.getByTestId('graph-filter-empty')).toHaveCount(0);
  });

  test('local graph panel draws and fits its neighbours too', async ({ page, vault }) => {
    const [source] = await vault.seed([
      { title: 'Source', content: 'Points at [[Target]] and [[Other]].' },
      { title: 'Target', content: 'Back to [[Source]].' },
      { title: 'Other', content: 'Back to [[Source]].' },
    ]);

    await page.goto('/');
    await page.getByTestId(`page-item-${source.id}`).click();
    await expect(page.getByTestId('editor')).toBeVisible();
    await page.getByTestId('local-graph-toggle').click();

    const local = page.getByTestId('local-graph-canvas');
    await expect(local).toBeVisible();
    await expect(local).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
    await page.waitForTimeout(700);

    const stats = await readCanvas(page, 'local-graph-canvas');
    expect(stats.count).toBeGreaterThan(200);
    expectDrawnAndFitted(stats);
  });
});

test.describe('high-DPI canvas', () => {
  // Retina/200%-zoom users must get a crisp canvas, in both browsers.
  test.use({ deviceScaleFactor: 2 });

  test('uses a devicePixelRatio backing store', async ({ page, vault }) => {
    await vault.seed(graphFixture());
    await openGraph(page);

    const stats = await readCanvas(page);
    expect(stats.dpr).toBeGreaterThanOrEqual(2);
    expect(stats.backingWidth / stats.cssWidth).toBeGreaterThanOrEqual(1.9);
    expect(stats.backingHeight / stats.cssHeight).toBeGreaterThanOrEqual(1.9);
    expectDrawnAndFitted(stats);
  });
});
