#!/usr/bin/env node
/**
 * Web timings on a big vault (#g95wkd9y, dev/performance-budget).
 *
 *   node scripts/perf/measure-web.mjs http://127.0.0.1:<web port> [--runs 3] [--throttle 4] [--json out.json]
 *
 * Point it at `vite preview` (a production build) whose /api proxy reaches a
 * server started on the big vault (scripts/perf/make-vault.mjs), with the dev
 * entry so it writes nothing to your app data (D47's installation id):
 * `GUMPLY_VAULT=<vault> GUMPLY_PORT=<port> npx tsx apps/server/src/dev.ts`. Every run
 * uses a fresh browser context (cold cache) with the CPU throttled via CDP,
 * as scripts/measure-startup.mjs does, and reports medians of:
 *   - editor visible ("app start, warm server" on the budget page): navigation
 *     → the landing page's body is in the DOM, in a fresh context;
 *   - sidebar ready: navigation → the page tree has rows (and how many rows
 *     are in the DOM, to see whether it's virtualised);
 *   - long tasks: the main thread's blocked time until 2 s after the editor;
 *   - Cmd+K: typing "roadmap" → more than one result row;
 *   - open a page from the sidebar (#7giyynna): the route a tree click takes →
 *     the page's last line in the editor and one frame painted, for
 *     make-vault's "Perf Typical", "Perf Rich" (tables, math, Mermaid, code)
 *     and "Perf Long" (~2,000 lines): openTypical, openRich, openLong;
 *   - Hub's backlinks: opening the hub page → its "Linked from" rows;
 *   - local graph and global graph: the click → a painted canvas;
 *   - graphSettled: the click → the global graph settled and fitted
 *     (`data-graph-ready`, and no `data-graph-arranging`). It replaces
 *     graphReady, which before 38fc612 timed an early flip of the attribute
 *     (~8 s into a 22-44 s layout on 10k); its old numbers aren't comparable.
 *     And graphLongest: the longest single main-thread
 *     task in that time (what makes the page feel frozen while it lays out).
 */
import { writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const url = (args.find((arg) => !arg.startsWith("--")) ?? "http://127.0.0.1:5440").replace(/\/+$/, "");
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const runs = Number(option("runs", "3"));
const throttle = Number(option("throttle", "4"));
const jsonOut = option("json", "");

const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};

const probe = () => {
  const marks = { longTasks: 0 };
  window.__perfMarks = marks;
  window.__longTaskLog = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!marks.settled) marks.longTasks += entry.duration;
      window.__longTaskLog.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: "longtask", buffered: true });
  new MutationObserver(() => {
    if (marks.editor === undefined && document.querySelector('[data-testid="editor-content"]')) marks.editor = performance.now();
    if (marks.sidebar === undefined && document.querySelector('[data-testid="page-tree"] [data-testid^="page-item-"]')) marks.sidebar = performance.now();
  }).observe(document, { childList: true, subtree: true });
  /** ms from now until `test()` holds and one frame has painted. */
  window.__until = (test, key) => {
    const start = performance.now();
    const tick = () => (test() ? requestAnimationFrame(() => (marks[key] = performance.now() - start)) : requestAnimationFrame(tick));
    tick();
  };
};

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(probe);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    const result = {};
    const marks = () => page.evaluate(() => window.__perfMarks);
    const wait = (key, timeout = 120_000) => page.waitForFunction((k) => window.__perfMarks[k] !== undefined, key, { timeout });

    await page.goto(`${url}/`, { waitUntil: "commit" });
    await wait("editor");
    await wait("sidebar");
    await page.waitForTimeout(2000);
    await page.evaluate(() => (window.__perfMarks.settled = true));
    let m = await marks();
    result.editor = m.editor;
    result.sidebar = m.sidebar;
    result.longTasks = m.longTasks;
    result.sidebarRows = await page.locator('[data-testid="page-tree"] [data-testid^="page-item-"]').count();

    // Cmd+K: type a common word, wait for results.
    await page.keyboard.press("Control+k");
    await page.getByTestId("quick-switcher-input").waitFor();
    await page.evaluate(() => window.__until(() => document.querySelectorAll('[data-testid="quick-switcher"] [role="option"]').length > 1, "cmdk"));
    await page.keyboard.type("roadmap");
    await wait("cmdk");
    result.cmdk = (await marks()).cmdk;
    await page.keyboard.press("Escape");

    // Open a page from the sidebar (#7giyynna): the hash route a tree click
    // takes, until the page's end marker is in the editor and a frame painted.
    for (const [key, id, marker] of [
      ["openTypical", "Perf Typical", "TYPICAL-END"],
      ["openRich", "Perf Rich", "RICH-END"],
      ["openLong", "Perf Long", "LONG-END"],
    ]) {
      await page.waitForTimeout(2500);
      await page.evaluate(
        ([key, id, marker]) => {
          window.__until(() => document.querySelector('[data-testid="editor-content"]')?.textContent.includes(marker) === true, key);
          location.hash = `#/${encodeURIComponent(id)}`;
        },
        [key, id, marker],
      );
      await wait(key);
      result[key] = (await marks())[key];
    }

    // The hub page and its backlinks.
    await page.evaluate(() => {
      window.__until(() => document.querySelector('[data-testid^="backlink-"]') !== null, "backlinks");
      location.hash = "#/Hub";
    });
    await wait("backlinks");
    result.backlinks = (await marks()).backlinks;

    // Local graph of the hub, then the global graph.
    await page.evaluate(() => window.__until(() => document.querySelector('[data-testid="local-graph-canvas"] canvas, [data-testid="local-graph-empty"]') !== null, "localGraph"));
    await page.getByTestId("local-graph-toggle").click();
    await wait("localGraph");
    result.localGraph = (await marks()).localGraph;
    await page.getByTestId("local-graph-toggle").click();
    await page.evaluate(() => window.__until(() => document.querySelector('[data-testid="graph-canvas"] canvas') !== null, "graph"));
    const clickedAt = await page.evaluate(() => performance.now());
    await page.getByTestId("sidebar-graph").click();
    await wait("graph");
    result.graph = (await marks()).graph;
    // Settled and fitted, and the longest task on the way there.
    await page
      .waitForFunction(
        () => {
          const canvas = document.querySelector('[data-testid="graph-canvas"]');
          // Settled: ready, and no worker layout still arranging (@opus-editor, #xb4b54gr).
          return canvas?.getAttribute("data-graph-ready") === "true" && !canvas.hasAttribute("data-graph-arranging");
        },
        null,
        { timeout: 300_000 },
      )
      .catch(async (error) => {
        const state = await page.evaluate(() => {
          const canvas = document.querySelector('[data-testid="graph-canvas"]');
          return canvas ? Object.fromEntries([...canvas.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value])) : "no graph canvas";
        });
        throw new Error(`the global graph never got ready: ${JSON.stringify(state)}`, { cause: error });
      });
    const readyAt = await page.evaluate(() => performance.now());
    result.graphSettled = readyAt - clickedAt;
    result.graphLongest = await page.evaluate(
      ([from, to]) => Math.max(0, ...window.__longTaskLog.filter((task) => task.start >= from && task.start <= to).map((task) => task.duration)),
      [clickedAt, readyAt],
    );

    results.push(result);
    console.log(`run ${run + 1}: ${JSON.stringify(Object.fromEntries(Object.entries(result).map(([k, v]) => [k, Math.round(v)])))}`);
    await context.close();
  }
} finally {
  await browser.close();
}

const summary = {};
for (const key of Object.keys(results[0] ?? {})) summary[key] = median(results.map((r) => r[key]));
console.log(`\nmedians at ${throttle}x CPU over ${runs} runs:`);
for (const [key, value] of Object.entries(summary)) console.log(`${key.padEnd(12)} ${value === null ? "n/a" : Math.round(value)}`);
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ url, runs, throttle, results, summary }, null, 2)}\n`);
