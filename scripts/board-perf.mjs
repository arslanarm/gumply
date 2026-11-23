#!/usr/bin/env node
/**
 * Whiteboard performance (#r6biyzx6): builds the board lab in production mode,
 * serves it, and measures frame rates for the gestures that matter on big
 * boards. Prints a Markdown table.
 *
 *   node scripts/board-perf.mjs [--seeds 500,1000] [--throttle 1,4] [--gpu]
 *                               [--port 5440] [--url http://host:port] [--check]
 *
 * - Boards come from `board-lab.html?seed=N&mix=1`: N objects (stickies with
 *   Markdown and [[links]], shapes, text, every 10th a live page card) and
 *   0.6·N connectors, every 5th labelled. The view is fitted, so every object
 *   is on screen (the worst case).
 * - Gestures: drag 1 object, drag 50 selected, drag all (Ctrl+A), pan (wheel),
 *   zoom (Ctrl+wheel); 60 pointer/wheel events about 16 ms apart.
 * - fps / p95 come from a requestAnimationFrame loop during the gesture; a
 *   busy main thread shows up as long frames. "moved/selected" checks that the
 *   drag really moved what it selected (read once the drop is committed).
 * - `--throttle 4` slows the CPU 4× through CDP (a mid-range laptop).
 * - `--gpu` turns on GPU rasterisation in headless Chromium (closer to a real
 *   browser; software rendering is the default and the more pessimistic).
 * - `--zoom 0.15` opens every board at that fixed zoom (a remembered view)
 *   instead of fitting it, so two builds are compared at an identical zoom.
 * - `--check` exits non-zero when drag-all of 500 at 1× drops below 50 fps.
 * - "ms" is the wall time of the whole gesture: the 60 paced (16 ms) mouse
 *   or wheel steps take longer when the page can't keep up.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const seeds = option("seeds", "500,1000").split(",").map(Number);
const throttles = option("throttle", "1,4").split(",").map(Number);
const gpu = args.includes("--gpu");
const check = args.includes("--check");
const port = Number(option("port", "5440"));
const fixedZoom = option("zoom", "") ? Number(option("zoom", "")) : null;
let base = option("url", "");

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
let server = null;
let outDir = null;

if (!base) {
  const { build, preview } = await import("vite");
  outDir = mkdtempSync(join(tmpdir(), "gumply-board-perf-"));
  const config = {
    root: webRoot,
    configFile: join(webRoot, "vite.config.ts"),
    logLevel: "warn",
  };
  await build({
    ...config,
    build: {
      outDir,
      emptyOutDir: true,
      rollupOptions: { input: { main: join(webRoot, "index.html"), lab: join(webRoot, "board-lab.html") } },
    },
  });
  server = await preview({ ...config, build: { outDir }, preview: { port, strictPort: true } });
  base = `http://localhost:${port}`;
}

const browser = await chromium.launch({
  args: gpu ? ["--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=gl-egl"] : [],
});

async function openBoard(seed, throttle) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const id = `perf-${seed}-${Date.now()}`;
  if (fixedZoom !== null) {
    await page.addInitScript(
      ([key, zoom]) => window.localStorage.setItem(key, JSON.stringify({ x: 80, y: 40, zoom })),
      [`gumply:board-view:lab:${id}`, fixedZoom],
    );
  }
  await page.goto(`${base}/board-lab.html?seed=${seed}&mix=1&id=${id}`);
  await page.waitForSelector(".react-flow__node");
  // Click an empty corner so nothing gets selected; fit unless the zoom is fixed.
  await page.mouse.click(5, 450);
  if (fixedZoom === null) await page.keyboard.press("Shift+Digit1");
  await page.waitForTimeout(600);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  await page.waitForTimeout(400);
  return page;
}

/** Run `gesture` while recording frame times. */
async function frames(page, gesture) {
  await page.evaluate(() => {
    const w = window;
    w.__perf = { frames: [], on: true };
    const tick = (t) => {
      if (!w.__perf.on) return;
      w.__perf.frames.push(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const startedAt = Date.now();
  await gesture();
  const wall = Date.now() - startedAt;
  await page.waitForTimeout(50);
  const times = await page.evaluate(() => {
    window.__perf.on = false;
    return window.__perf.frames;
  });
  const gaps = times
    .slice(1)
    .map((t, i) => t - times[i])
    .sort((a, b) => a - b);
  const span = times.at(-1) - times[0];
  return {
    wall,
    fps: Math.round(((times.length - 1) / span) * 1000),
    p95: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
    worst: Math.round(gaps.at(-1) ?? 0),
  };
}

const positions = (page) =>
  page.evaluate(() => Object.fromEntries(window.__board.get().nodes.map((n) => [n.id, `${n.x},${n.y}`])));

/** Select `count` objects (all for Infinity); returns a point on one of them. */
async function select(page, count) {
  if (count === Infinity) {
    await page.keyboard.press("Control+a");
  } else {
    // #g95wkd9y: the next object is picked from the page as it is *now*, after
    // each click. The context toolbar appears over the selection and DOM order
    // isn't screen order, so points worked out up front were often under the
    // toolbar: the clicks hit its buttons and only one object got selected.
    const nextPoint = () =>
      page.evaluate(() => {
        for (const el of document.querySelectorAll(".react-flow__node:not(.selected)")) {
          const r = el.getBoundingClientRect();
          // Near the top-left inner edge, not the centre: text there may be a
          // [[link]], and clicking a link opens it instead of selecting.
          const x = r.x + Math.min(6, r.width / 4);
          const y = r.y + Math.min(6, r.height / 4);
          const hit = document.elementFromPoint(x, y);
          // Only objects nothing else (toolbars, minimap) covers right now.
          if (r.y > 120 && y < 860 && hit && el.contains(hit) && !hit.closest("a, .wiki-link, button")) return { x, y };
        }
        return null;
      });
    // React Flow tracks Shift through keydown, not the click's shiftKey.
    for (let index = 0; index < count; index += 1) {
      const point = await nextPoint();
      if (!point) break;
      if (index === 1) await page.keyboard.down("Shift");
      await page.mouse.click(point.x, point.y);
    }
    await page.keyboard.up("Shift");
  }
  await page.waitForTimeout(300);
  // Grab the selected object nearest the middle: starting near the edge of the
  // view would make React Flow auto-pan for the whole drag.
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll(".react-flow__node.selected")) {
      const r = el.getBoundingClientRect();
      const x = r.x + Math.min(6, r.width / 4);
      const y = r.y + Math.min(6, r.height / 4);
      const hit = document.elementFromPoint(x, y);
      if (!el.contains(hit) || hit.closest("a, .wiki-link, button")) continue;
      const distance = Math.hypot(x - 720, y - 450);
      if (!best || distance < best.distance) best = { x, y, distance };
    }
    return { ...best, selected: document.querySelectorAll(".react-flow__node.selected").length };
  }).then((start) => {
    if (start.x === undefined) throw new Error(`no selected object to grab (${start.selected} selected)`);
    return start;
  });
}

/**
 * #g95wkd9y: wait until the drop is committed. A big selection moves with CSS
 * offsets (or the viewport transform) during the drag and its positions are
 * written once on drop; at 1,000 objects that commit can take longer than a
 * fixed wait, which read as "moved 0".
 */
async function settled(page, before, timeout = 15_000) {
  const until = Date.now() + timeout;
  for (;;) {
    const state = await page.evaluate(() => ({
      temporary:
        [...document.querySelectorAll(".react-flow__node")].some((el) => el.style.translate !== "") ||
        (document.querySelector(".react-flow__viewport")?.style.translate ?? "") !== "",
      nodes: Object.fromEntries(window.__board.get().nodes.map((n) => [n.id, `${n.x},${n.y}`])),
    }));
    const moved = Object.keys(state.nodes).filter((id) => state.nodes[id] !== before[id]).length;
    if ((!state.temporary && moved > 0) || Date.now() > until) return moved;
    await page.waitForTimeout(100);
  }
}

async function drag(page, count) {
  const start = await select(page, count);
  const before = await positions(page);
  const result = await frames(page, async () => {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    for (let i = 1; i <= 60; i += 1) {
      await page.mouse.move(start.x + i * 3, start.y + i * 2);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });
  const moved = await settled(page, before);
  // A drag that didn't move what it selected measures nothing: say so loudly.
  if (moved !== start.selected) console.error(`warning: ${start.selected} selected but ${moved} moved`);
  return { ...result, moved, selected: start.selected };
}

async function wheel(page, zoom) {
  await page.mouse.move(720, 450);
  if (zoom) await page.keyboard.down("Control");
  const result = await frames(page, async () => {
    for (let i = 0; i < 60; i += 1) {
      await page.mouse.wheel(zoom ? 0 : 12, zoom ? (i < 30 ? -12 : 12) : 12);
      await page.waitForTimeout(16);
    }
  });
  if (zoom) await page.keyboard.up("Control");
  return result;
}

const gestures = [
  ["drag 1", (page) => drag(page, 1)],
  ["drag 50", (page) => drag(page, 50)],
  ["drag all", (page) => drag(page, Infinity)],
  ["pan", (page) => wheel(page, false)],
  ["zoom", (page) => wheel(page, true)],
];

const rows = [];
let failed = false;
try {
  for (const seed of seeds) {
    for (const throttle of throttles) {
      for (const [name, run] of gestures) {
        const page = await openBoard(seed, throttle);
        const r = await run(page);
        await page.close();
        const moved = r.moved === undefined ? "" : `${r.moved}/${r.selected}`;
        rows.push(`| ${seed} | ${throttle}× | ${name} | ${r.fps} | ${r.p95} | ${r.worst} | ${r.wall} | ${moved} |`);
        console.error(`${seed} ${throttle}× ${name}: ${JSON.stringify(r)}`);
        if (check && seed === 500 && throttle === 1 && name === "drag all" && r.fps < 50) failed = true;
      }
    }
  }
} finally {
  await browser.close();
  await server?.close?.();
  if (server?.httpServer) await new Promise((resolve) => server.httpServer.close(resolve));
  if (outDir) rmSync(outDir, { recursive: true, force: true });
}

console.log(
  `Board perf — ${gpu ? "GPU" : "software"} rendering, 1440×900, ${fixedZoom === null ? "whole board visible" : `zoom ${Math.round(fixedZoom * 100)}%`}\n`,
);
console.log("| objects | CPU | gesture | fps | p95 frame ms | worst frame ms | gesture ms | moved/selected |");
console.log("|---|---|---|---|---|---|---|---|");
for (const row of rows) console.log(row);
if (failed) {
  console.error("drag all (500 objects, 1× CPU) is below 50 fps");
  process.exit(1);
}
