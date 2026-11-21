import type { Page, TestInfo } from '@playwright/test';
import { BASE_URL } from './env';
import { contention, describeContention } from './perf';
import { budgetScale, PAGE_OPEN_BASE_MS, pageOpenTimeout } from './perf-scale';

/**
 * Page opens wait for the app to boot, with a load-aware budget (#rqtacq4d).
 *
 * The suite runs the app from the Vite dev server: every `page.goto` in a fresh
 * context loads ~240 unbundled modules, boots React and fetches the page list
 * before anything is on screen. On a quiet machine that takes 0.2–0.4 s. With
 * several suites on one machine, the browser is starved of CPU and the same
 * open took 3.5–5.6 s, sometimes 15 s, in @opus-hunter's measurements. That was
 * the "`editor-content` not visible within 5 s" flake, in whichever spec opened
 * a page at the wrong moment.
 *
 * So `page.goto` and `page.reload` (through the `page` fixture in
 * `fixtures.ts`) return only once the app has booted: the sidebar's page tree
 * is rendered and no longer says "Loading". That wait gets 5 s on a quiet
 * machine, scaled with CPU pressure and load (`perf-scale.ts`), and never more
 * than 15 s. The test's own assertions after it keep the strict 5 s, so
 * slowness *inside* the app (opening a page, typing, saving) still fails.
 *
 * Not waited for:
 * - calls with an explicit `waitUntil` (the test controls loading itself, e.g.
 *   the first-paint specs that block the bundle);
 * - URLs that aren't the app (`about:blank`, `board-lab.html`, `/api/…`).
 *
 * A boot slower than the quiet 5 s is still allowed under load, but lands in the
 * test's annotations (`slow-page-open`) and the log, so a slow app stays visible.
 * `GUMPLY_PERF_STRICT=1` forces the quiet 5 s (reproduce CI locally).
 */

/** In the page: the sidebar tree has the page list (or the empty/error state). */
function appBooted(): boolean {
  const tree = document.querySelector('[data-testid="page-tree"]');
  return tree !== null && tree.querySelector(':scope > .tree-note') === null;
}

/** The app itself: same origin as `base` (the suite's web server), at `/` (any hash). */
export function isAppUrl(url: string, base: string = BASE_URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === new URL(base).origin && (parsed.pathname === '/' || parsed.pathname === '/index.html');
}

/** Wait until the app has booted, within the load-aware page-open budget. */
export async function waitForAppBoot(page: Page, testInfo: TestInfo, what: string): Promise<void> {
  const c = contention();
  const timeout = pageOpenTimeout(budgetScale(c, process.env.GUMPLY_PERF_STRICT === '1'));
  const started = Date.now();
  try {
    await page.waitForFunction(appBooted, undefined, { timeout, polling: 100 });
  } catch (error) {
    if (page.isClosed()) throw error;
    throw new Error(
      `The app didn't finish booting within ${timeout / 1000} s after ${what} ` +
        `(the sidebar's page tree never appeared or kept saying "Loading"; ${describeContention(c)}).`,
    );
  }
  const took = Date.now() - started;
  if (took > PAGE_OPEN_BASE_MS) {
    const note = `${what}: the app booted after ${(took / 1000).toFixed(1)} s (budget ${timeout / 1000} s; ${describeContention(c)})`;
    testInfo.annotations.push({ type: 'slow-page-open', description: note });
    console.log(`[slow-page-open] ${note}`);
  }
}

/**
 * Make `page.goto` / `page.reload` wait for the app to boot (see above).
 * `base` is the app's URL: the suite's web server, or e.g. the demo spec's own app.
 */
export function waitForBootOnNavigation(page: Page, testInfo: TestInfo, base: string = BASE_URL): void {
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    const response = await goto(url, options);
    if (options?.waitUntil === undefined && isAppUrl(page.url(), base)) await waitForAppBoot(page, testInfo, `goto ${url}`);
    return response;
  };
  const reload = page.reload.bind(page);
  page.reload = async (options) => {
    const response = await reload(options);
    if (options?.waitUntil === undefined && isAppUrl(page.url(), base)) await waitForAppBoot(page, testInfo, 'reload');
    return response;
  };
}
