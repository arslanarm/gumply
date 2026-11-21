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

    const scrollFrames = () =>
      page.evaluate(async () => {
        const target = document.querySelector<HTMLElement>('[data-testid="base-table-scroll"]')!;
        const frames: number[] = [];
        let last = performance.now();
        let running = true;
        const tick = (now: number) => {
          frames.push(now - last);
          last = now;
          if (running) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        target.scrollTop = 0;
        // Top to bottom in ~2 s of 60 fps steps.
        const step = Math.ceil((target.scrollHeight - target.clientHeight) / 120);
        while (target.scrollTop + target.clientHeight < target.scrollHeight - 1) {
          target.scrollBy(0, step);
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        running = false;
        frames.shift();
        const sorted = [...frames].sort((a, b) => a - b);
        const avg = frames.reduce((sum, value) => sum + value, 0) / frames.length;
        return { frames: frames.length, avg, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 };
      });

    // Budgets for the dev build on a quiet machine, scaled by load (e2e/support/perf.ts).
    const result = await measure(testInfo, 'table scroll', scrollFrames, (r) => [
      [r.avg, 20, 'table scroll avg frame ms'],
      [r.p95, 34, 'table scroll p95 frame ms'],
    ], { attempts: 2 });
    console.log(
      `[bases-perf] 2,000-row table, ${result.frames} frames: avg ${result.avg.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms`,
    );
    await expect(page.getByTestId('base-row-Big/Item 1999')).toBeVisible();
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });
});
