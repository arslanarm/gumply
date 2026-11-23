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
 * - Gestures: drag 1 object (clicked), drag 50 (a selection box over at least
 *   50 objects), drag all (Ctrl+A), pan (wheel), zoom (Ctrl+wheel); 60
 *   pointer/wheel events about 16 ms apart. Objects are grabbed at a point
 *   that moves them: never a connection handle (at a fitted 1,000-object
 *   board, ~20×12 px objects, a corner point hit the handle), link or button.
 * - fps / p95 come from a requestAnimationFrame loop during the gesture; a
 *   busy main thread shows up as long frames. "moved/selected" checks that the
 *   drag really moved what it selected (read once the drop is committed).
 * - `--throttle 4` slows the CPU 4× through CDP (a mid-range laptop).
 * - `--gpu` turns on GPU rasterisation in headless Chromium (closer to a real
 *   browser; software rendering is the default and the more pessimistic).
 * - `--zoom 0.15` opens every board at that fixed zoom (a remembered view)
 *   instead of fitting it, so two builds are compared at an identical zoom.
 * - The run exits non-zero when a drag moved nothing or not what it selected
 *   (or "drag 50" selected fewer than 30): those rows measured the wrong thing.
 * - `--check` also exits non-zero when drag-all of 500 at 1× drops below 50 fps.
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
  await page.addInitScript(() => {
    /**
     * A point on an object that grabs (or selects) the object itself. #g95wkd9y:
     * at a fitted 1,000-object board (zoom 0.1) objects are about 20×12 px, and
     * a fixed point near the corner landed on a connection handle (`.nodrag`),
     * which starts a connector instead: those drags moved nothing. Links and
     * buttons are skipped too (a [[link]] opens instead of selecting), and so
     * is anything covering the object (toolbars, the minimap).
     */
    window.__perfPointOn = (el, forSelection = false) => {
      const r = el.getBoundingClientRect();
      // For Shift-click selection, only the lower body: a click near an
      // object's top (a card's header, say) can select that object alone and
      // drop the rest of the selection.
      const spots = [[0.3, 0.6], [0.7, 0.6], [0.5, 0.75]];
      if (!forSelection) spots.push([0.25, 0.35], [0.75, 0.35], [0.5, 0.5]);
      for (const [fx, fy] of spots) {
        const x = r.x + r.width * fx;
        const y = r.y + r.height * fy;
        const hit = document.elementFromPoint(x, y);
        // After a box selection React Flow lays its selection rectangle over the
        // selected objects; grabbing that is how such a selection is dragged.
        const onSelectionRect = el.classList.contains("selected") && hit?.closest(".react-flow__nodesselection-rect");
        if (hit && (onSelectionRect || (el.contains(hit) && !hit.closest("a, .wiki-link, button, .nodrag, .react-flow__handle")))) return { x, y };
      }
      return null;
    };
  });
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
  } else if (count === 1) {
    const point = await page.evaluate(() => {
      for (const el of document.querySelectorAll(".react-flow__node")) {
        const point = window.__perfPointOn(el, true);
        if (point && point.y > 120 && point.y < 860) return point;
      }
      return null;
    });
    if (point) await page.mouse.click(point.x, point.y);
  } else {
    // #g95wkd9y: a selection box dragged from the empty canvas left of the
    // board, down until at least `count` objects are inside it (the board
    // selects what the box touches). Shift-clicking that many objects one by one at a fitted
    // 1,000-object board (objects ~20×12 px, a toolbar following the
    // selection) kept losing the selection part-way.
    const box = await page.evaluate((n) => {
      // Below the app's top bar and the board toolbar (the fitted board starts
      // under them), in the empty margin left of the leftmost object.
      const top = 125;
      const rects = [...document.querySelectorAll(".react-flow__node")].map((el) => el.getBoundingClientRect()).filter((r) => r.bottom > top);
      const left = Math.min(...rects.map((r) => r.left)) - 6;
      const right = Math.max(...rects.map((r) => r.right)) + 6;
      const bottoms = rects.map((r) => r.bottom).sort((a, b) => a - b);
      return { left, top, right, bottom: Math.min(860, (bottoms[Math.min(n, bottoms.length) - 1] ?? top) + 2) };
    }, count);
    // The select tool draws a selection box on a plain drag over empty canvas.
    await page.mouse.move(box.left, box.top);
    await page.mouse.down();
    for (let i = 1; i <= 10; i += 1) {
      await page.mouse.move(box.left + ((box.right - box.left) * i) / 10, box.top + ((box.bottom - box.top) * i) / 10);
    }
    await page.mouse.up();
  }
  await page.waitForTimeout(300);
  // Grab the selected object nearest the middle: starting near the edge of the
  // view would make React Flow auto-pan for the whole drag.
  return page.evaluate(() => {
    let best = null;
    for (const el of document.querySelectorAll(".react-flow__node.selected")) {
      const point = window.__perfPointOn(el);
      if (!point) continue;
      const distance = Math.hypot(point.x - 720, point.y - 450);
      if (!best || distance < best.distance) best = { ...point, distance };
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
const noOps = [];
let failed = false;
try {
  for (const seed of seeds) {
    for (const throttle of throttles) {
      for (const [name, run] of gestures) {
        const page = await openBoard(seed, throttle);
        const r = await run(page);
        await page.close();
        // #g95wkd9y: a drag that moved nothing, or not what it selected, measured a
        // no-op (or the wrong gesture): the row is marked and the run fails.
        const bad = r.moved !== undefined && (r.moved === 0 || r.moved !== r.selected || (name === "drag 50" && r.selected < 30));
        if (bad) {
          noOps.push(`${seed} ${throttle}× ${name}: ${r.moved} moved of ${r.selected} selected`);
          failed = true;
        }
        const moved = r.moved === undefined ? "" : `${r.moved}/${r.selected}${bad ? " FAILED" : ""}`;
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
for (const line of noOps) console.error(`drag didn't move its selection: ${line}`);
if (failed) {
  if (check) console.error("--check: drag all (500 objects, 1× CPU) must reach 50 fps, and every drag must move its selection");
  process.exit(1);
}
