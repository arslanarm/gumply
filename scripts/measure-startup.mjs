#!/usr/bin/env node
/**
 * Cold-start timings of a running Gumply web app (#evh35bn7).
 *
 *   node scripts/measure-startup.mjs http://localhost:5440 [--runs 7] [--throttle 4]
 *
 * Every run uses a fresh browser context (empty cache) with the CPU throttled
 * via CDP, and reports medians of:
 *   - editor visible: navigation start → the page body (editor-content) is
 *     in the DOM,
 *   - graph open: click on the sidebar's Graph row → the graph canvas exists
 *     and one frame has been painted,
 *   - local graph open: click on "Local graph" → its canvas (or its "no
 *     links yet" state) has painted,
 *   - JS / CSS bytes fetched before the editor was visible (encoded, i.e.
 *     what the network moved; the dev server sends uncompressed).
 * `--idle 4000` waits that long before opening the graphs (after the app's
 * idle preload). Point it at `vite preview` for production numbers or `vite`
 * for dev ones.
 */
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const url = args.find((arg) => !arg.startsWith("--")) ?? "http://localhost:5440";
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? Number(args[index + 1]) : fallback;
};
const runs = option("runs", 7);
const throttle = option("throttle", 4);
// Wait this long after the editor shows before opening the graphs (lets the
// app's idle preload run first, like a user who reads before clicking).
const idleMs = option("idle", 0);

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Records when the editor first shows text, and how long after a click a
// graph canvas takes to appear and paint.
const probe = () => {
  const marks = {};
  window.__startupMarks = marks;
  const check = () => {
    if (marks.editor === undefined) {
      // The page body is mounted (it may be empty) and its title is shown.
      if (document.querySelector('[data-testid="editor-content"]')) marks.editor = performance.now();
    }
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  window.__waitForCanvas = (selector, key) => {
    const start = performance.now();
    const tick = () => {
      if (document.querySelector(selector)) {
        requestAnimationFrame(() => {
          marks[key] = performance.now() - start;
        });
      } else {
        requestAnimationFrame(tick);
      }
    };
    tick();
  };
};

const browser = await chromium.launch();
const results = { editor: [], graph: [], local: [], js: [], css: [], requests: [] };
try {
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(probe);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });

    await page.goto(url, { waitUntil: "commit" });
    await page.waitForFunction(() => window.__startupMarks?.editor !== undefined, null, { timeout: 60_000 });
    const loaded = await page.evaluate(() => {
      const editor = window.__startupMarks.editor;
      const bytes = { js: 0, css: 0, requests: 0 };
      for (const entry of performance.getEntriesByType("resource")) {
        if (entry.startTime > editor) continue;
        bytes.requests += 1;
        const size = entry.encodedBodySize || entry.transferSize;
        if (/\.(m?js|tsx?|jsx)(\?|$)/.test(entry.name) || entry.initiatorType === "script") bytes.js += size;
        else if (/\.css(\?|$)/.test(entry.name)) bytes.css += size;
      }
      return { editor, ...bytes };
    });
    results.editor.push(loaded.editor);
    results.js.push(loaded.js);
    results.css.push(loaded.css);
    results.requests.push(loaded.requests);

    if (idleMs > 0) await page.waitForTimeout(idleMs);
    // Local graph first (the editor is showing), then the global graph.
    await page.evaluate(() => window.__waitForCanvas(
      '[data-testid="local-graph-canvas"] canvas, [data-testid="local-graph-empty"]',
      "local",
    ));
    await page.getByTestId("local-graph-toggle").click();
    await page.waitForFunction(() => window.__startupMarks.local !== undefined, null, { timeout: 60_000 });
    await page.getByTestId("local-graph-toggle").click();
    await page.evaluate(() => window.__waitForCanvas('[data-testid="graph-canvas"] canvas', "graph"));
    await page.getByTestId("sidebar-graph").click();
    await page.waitForFunction(() => window.__startupMarks.graph !== undefined, null, { timeout: 60_000 });
    const marks = await page.evaluate(() => window.__startupMarks);
    results.local.push(marks.local);
    results.graph.push(marks.graph);
    await context.close();
  }
} finally {
  await browser.close();
}

const ms = (value) => `${Math.round(value)} ms`;
const kb = (value) => `${(value / 1024).toFixed(0)} kB`;
console.log(`${url} — ${runs} cold runs, CPU ×${throttle}${idleMs ? `, graphs opened ${idleMs} ms after the editor` : ""}, medians`);
console.log(`  editor visible   ${ms(median(results.editor))}  (min ${ms(Math.min(...results.editor))}, max ${ms(Math.max(...results.editor))})`);
console.log(`  local graph open ${ms(median(results.local))}`);
console.log(`  graph open       ${ms(median(results.graph))}`);
console.log(`  JS before editor ${kb(median(results.js))}, CSS ${kb(median(results.css))}, ${median(results.requests)} requests`);
