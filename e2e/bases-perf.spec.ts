import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';
import { measure } from './support/perf';

/**
 * v0.7 B (#sg36ng2d, spec/v0-7 B): 2,000 pages in a table scroll smoothly.
 * Rows are virtualised, so only what's on screen is in the DOM.
 */
test.describe('database view performance', () => {
  test('a 2,000-page table scrolls smoothly top to bottom', async ({ page, request, vault }, testInfo) => {
    void vault;
    test.setTimeout(120_000);
    const statuses = ['Todo', 'Doing', 'Done', 'Blocked'];
    const dir = path.join(E2E_VAULT, 'Big');
    await fs.mkdir(dir, { recursive: true });
    await Promise.all(
      Array.from({ length: 2000 }, (_, i) =>
        fs.writeFile(
          path.join(dir, `Item ${String(i).padStart(4, '0')}.md`),
          `---\nstatus: ${statuses[i % 4]}\ndue: 2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}\nestimate: ${i % 13}\ntags: [t${i % 7}, shared]\ndone: ${i % 3 === 0}\n---\nBody ${i}\n`,
        ),
      ),
    );
    // The base sits outside `Big/` so the sidebar keeps that folder closed:
    // 2,000 open tree rows slow every scroll on the page (hit testing over
    // ~40k layout objects), table or not. That's measured separately.
    await fs.writeFile(
      path.join(E2E_VAULT, 'All.base'),
      'filters:\n  and:\n    - file.inFolder("Big")\nviews:\n  - type: table\n    name: Everything\n    order: [file.name, status, due, estimate, tags, done]\n    sort:\n      - property: file.name\n        direction: ASC\n',
    );
    await expect.poll(async () => (await api.listPages(request)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2002);

    await page.goto('/#/All.base');
    await expect(page.getByTestId('base-count')).toHaveText('2,000 pages', { timeout: 20_000 });
    const scroller = page.getByTestId('base-table-scroll');
    // Virtualised: a screenful of rows in the DOM, not 2,000.
    expect(await page.locator('.base-tr').count()).toBeLessThan(80);

    /**
     * One frame loop standing still (what this machine's frames cost right
     * now), then one scrolling the table top to bottom at 170 px a frame:
     * 10,000 px/s, a hard trackpad fling, 5 new rows a frame. (An earlier
     * version crossed all 2,000 rows in 2 s, 17 new rows a frame: the dev
     * build's React render alone took ~7 ms of each frame there, so any
     * contention dropped frames; #sg36ng2d.)
     */
    const frameLoop = (scroll: boolean) =>
      page.evaluate(async (scroll) => {
        const target = document.querySelector<HTMLElement>('[data-testid="base-table-scroll"]')!;
        target.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 200));
        const step = scroll ? 170 : 0;
        const count = scroll ? Math.ceil((target.scrollHeight - target.clientHeight) / step) + 1 : 120;
        const frames: number[] = [];
        let last = performance.now();
        for (let i = 0; i < count; i += 1) {
          if (step) target.scrollBy(0, step);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const now = performance.now();
          frames.push(now - last);
          last = now;
        }
        frames.shift();
        const sorted = [...frames].sort((a, b) => a - b);
        const avg = frames.reduce((sum, value) => sum + value, 0) / frames.length;
        return { frames: frames.length, avg, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 };
      }, scroll);

    /**
     * The table's own cost: scrolling frames minus standing-still frames,
     * measured back to back. A busy machine slows both (the load/PSI scaling
     * in e2e/support/perf.ts misses short bursts, #sg36ng2d); a slower
     * scroll path only the first. Budgets as on a quiet machine: 60 fps
     * (16.7 ms) plus 3.3 ms on average, at most one dropped frame at p95.
     */
    const measured = async () => {
      const idle = await frameLoop(false);
      const scroll = await frameLoop(true);
      return { idle, scroll, extraAvg: scroll.avg - idle.avg, extraP95: scroll.p95 - idle.p95 };
    };
    const result = await measure(testInfo, 'table scroll', measured, (r) => [
      [r.extraAvg, 3.3, 'table scroll avg ms over standing still'],
      [r.extraP95, 17, 'table scroll p95 ms over standing still'],
    ], { attempts: 2 });
    const format = (r: { frames: number; avg: number; p95: number; max: number }) =>
      `${r.frames} frames: avg ${r.avg.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms`;
    console.log(`[bases-perf] 2,000-row table scrolling, ${format(result.scroll)}; standing still, ${format(result.idle)}`);
    // Scrolled to the end, with the last row mounted.
    await expect(page.getByTestId('base-row-Big/Item 1999')).toBeVisible();
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
});
