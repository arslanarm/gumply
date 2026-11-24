import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * C1 (#xb4b54gr review): `data-graph-ready` means the layout has settled
 * (38fc612). A big graph's worker layout can also restart without new data
 * (reduced motion or the centre page changed); during that re-arrange the
 * graph isn't settled either, so it must not say ready until the worker is done.
 */
const NOTES = 1_600; // over the worker threshold (1,500)

test('a re-arrange of a big graph without new data is not "ready" until the worker is done', async ({ page, request, vault }) => {
  // The vault fixture resets before and after: the 1,600 notes written below must not reach
  // the next spec (graph.spec's empty-vault case failed right after this one).
  void vault;
  test.setTimeout(240_000);
  await fs.mkdir(path.join(E2E_VAULT, 'Many'), { recursive: true });
  for (let i = 0; i < NOTES; i += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, NOTES - i) }, (_, j) => {
        const n = i + j;
        const base = Math.floor(n / 20) * 20;
        return fs.writeFile(path.join(E2E_VAULT, 'Many', `Note ${n}.md`), `See [[Note ${base + ((n - base + 1) % 20)}]] and [[Note ${(n + 97) % NOTES}]].\n`);
      }),
    );
  }
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Many/')).length, { timeout: 60_000 })
    .toBe(NOTES);
  await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).headers()['x-gumply-syncing'] ?? 'off', { timeout: 15_000 }).toBe('off');

  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-layout', 'worker', { timeout: 60_000 });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 120_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');

  // Sample the two attributes from now on: "ready" while "arranging" must never be seen.
  await page.evaluate(() => {
    const seen = { readyWhileArranging: 0, notReady: 0 };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    setInterval(() => {
      const el = document.querySelector('[data-testid="graph-canvas"]');
      if (!el) return;
      const ready = el.getAttribute('data-graph-ready') === 'true';
      if (ready && el.hasAttribute('data-graph-arranging')) seen.readyWhileArranging += 1;
      if (!ready) seen.notReady += 1;
    }, 25);
  });

  // Reduced motion on: the same data, laid out again (settled once, behind "Arranging").
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'false', { timeout: 10_000 });

  // #3jep576p: while it arranges, the start layout is dimmed by a veil over the canvas.
  // The veil never takes the pointer (hover, click, drag and zoom reach the graph) or focus.
  await expect(canvas).toHaveAttribute('data-graph-arranging', 'true', { timeout: 10_000 });
  const veil = canvas.locator('.graph-arranging-veil');
  await expect(veil).toHaveCount(1);
  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="graph-canvas"]')!;
    const box = el.getBoundingClientRect();
    // A point clear of the centred status pill.
    const target = document.elementFromPoint(box.left + box.width * 0.25, box.top + box.height * 0.25);
    const veilEl = el.querySelector('.graph-arranging-veil') as HTMLElement;
    return { tag: target?.tagName, pointerEvents: getComputedStyle(veilEl).pointerEvents, tabIndex: veilEl.tabIndex, hidden: veilEl.getAttribute('aria-hidden') };
  });
  expect(hit).toEqual({ tag: 'CANVAS', pointerEvents: 'none', tabIndex: -1, hidden: 'true' });
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 120_000 });
  await expect(canvas).not.toHaveAttribute('data-graph-arranging', 'true');
  await expect(canvas).toHaveAttribute('data-graph-engine', 'stopped');

  const seen = await page.evaluate(() => (window as unknown as { __seen: { readyWhileArranging: number; notReady: number } }).__seen);
  expect(seen.notReady, 'the re-arrange was seen as not ready').toBeGreaterThan(0);
  expect(seen.readyWhileArranging, 'never "ready" while arranging').toBe(0);
});
