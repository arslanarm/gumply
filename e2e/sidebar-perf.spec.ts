import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { measure } from './support/perf';
import { expectPageTitle } from './support/ui';

/**
 * #dvy946h5: a big folder expanded in the sidebar must not slow down the
 * page. Found by @opus-board: with 2,000 rows shown, every scroll of the
 * page hit-tested ~41k layout objects (~30 ms frames instead of 16.7).
 */
const ROWS = 2000;

test.describe('sidebar with a big folder expanded', () => {
  test('scrolling a long page stays smooth with 2,000 rows in the sidebar', async ({ page, vault }, testInfo) => {
    test.setTimeout(120_000);
    await vault.seed([{ title: 'Anchor' }]);
    const big = path.join(E2E_VAULT, 'Big');
    mkdirSync(big, { recursive: true });
    for (let index = 0; index < ROWS; index += 1) {
      writeFileSync(path.join(big, `Item ${String(index).padStart(4, '0')}.md`), `---\nstatus: open\n---\nItem ${index}\n`);
    }
    const filler = Array.from({ length: 120 }, (_, index) => `Paragraph ${index}: words to scroll past, line after line.`).join('\n\n');
    writeFileSync(path.join(big, 'Long read.md'), `${filler}\n`);

    // Opening a page inside reveals (expands) its folder: all rows are in the tree.
    // The watcher indexes the 2,001 new files; open the page once the server has it.
    await expect
      .poll(async () => (await page.request.get(`${API_URL}/api/pages/${encodeURIComponent('Big/Long read')}`)).status(), { timeout: 30_000 })
      .toBe(200);
    await page.goto('/#/Big/Long read');
    // A 2,000-file vault: the first load takes a few seconds on a busy machine.
    await expect(page.getByTestId('page-title').first()).toBeVisible({ timeout: 20_000 });
    await expectPageTitle(page, 'Long read');
    await expect(page.getByTestId('page-item-Big/Item 1999')).toBeAttached({ timeout: 20_000 });

    // The pointer rests over the page, as when someone scrolls with a wheel:
    // the browser then hit-tests on every scroll (where the cost was).
    const content = await page.getByTestId('editor-content').boundingBox();
    if (content) await page.mouse.move(content.x + content.width / 2, content.y + 200);

    const scrollFrames = (steps: number, delta: number) =>
      page.evaluate(
        async ({ steps, delta }) => {
          let scroller: HTMLElement | null = document.querySelector<HTMLElement>('[data-testid="editor-content"]');
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) {
            scroller = scroller.parentElement;
          }
          const target: HTMLElement | Window = scroller ?? window;
          const frames: number[] = [];
          let last = performance.now();
          let running = true;
          const tick = (now: number) => {
            frames.push(now - last);
            last = now;
            if (running) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          for (let step = 0; step < steps; step += 1) {
            target.scrollBy(0, step >= steps / 2 ? -delta : delta);
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          running = false;
          frames.shift();
          const sorted = [...frames].sort((a, b) => a - b);
          const avg = frames.reduce((sum, value) => sum + value, 0) / frames.length;
          return { frames: frames.length, avg, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0 };
        },
        { steps, delta },
      );

    // Layout objects the browser keeps while scrolling (from a trace): with
    // off-screen rows skipped this stays far below one object per row.
    const browser = page.context().browser();
    let layoutObjects = 0;
    if (browser && browser.browserType().name() === 'chromium') {
      await browser.startTracing(page, { categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] });
      await scrollFrames(30, 40);
      const trace = JSON.parse((await browser.stopTracing()).toString('utf8')) as {
        traceEvents: Array<{ name: string; args?: { beginData?: { totalObjects?: number } } }>;
      };
      const layouts = trace.traceEvents.filter((event) => event.name === 'Layout');
      layoutObjects = Math.max(0, ...layouts.map((event) => event.args?.beginData?.totalObjects ?? 0));
      console.log(`[sidebar-perf] largest layout while scrolling: ${layoutObjects} objects`);
    }

    const result = await measure(
      testInfo,
      'page scroll with 2,000 sidebar rows',
      () => scrollFrames(100, 40),
      (r) => [
        [r.avg, 20, 'average frame ms'],
        [r.p95, 25, 'p95 frame ms'],
      ],
      { attempts: 2 },
    );
    console.log(`[sidebar-perf] ${result.frames} frames: avg ${result.avg.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms`);
    // Before #dvy946h5: ~40,000 (one set per row); with off-screen chunks skipped: ~1,500.
    if (layoutObjects > 0) expect(layoutObjects).toBeLessThan(10_000);

    // A row deep in a skipped chunk still works: it scrolls into view, opens,
    // and its menu isn't clipped by the chunk.
    const far = page.getByTestId('page-item-Big/Item 1500');
    await far.scrollIntoViewIfNeeded();
    await far.click();
    await expectPageTitle(page, 'Item 1500');
    await far.click({ button: 'right' });
    const menu = page.getByTestId('page-menu-Big/Item 1500');
    await expect(menu).toBeVisible();
    const rowBox = (await far.boundingBox())!;
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.height).toBeGreaterThan(rowBox.height);
  });
});
