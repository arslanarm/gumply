/**
 * Board export timing (spec/v0-6 §D, #yewapn9k): builds the board lab in
 * production mode and times Export as SVG / PNG from the ⋯ menu, from the
 * click to the finished download, on generated boards. The first export
 * after load is "cold" (export code, font and text fitting not cached yet).
 *
 *   node scripts/export-perf.mjs [--seeds 1000] [--runs 3] [--port 5441] [--check]
 *
 * --check exits non-zero when any export takes 3 s or more (spec target).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const seeds = option("seeds", "1000").split(",").map(Number);
const runs = Number(option("runs", "3"));
const port = Number(option("port", "5441"));
const check = process.argv.includes("--check");
const LIMIT_MS = 3000;

const webRoot = fileURLToPath(new URL("../apps/web/", import.meta.url));
const { build, preview } = await import("vite");
const outDir = mkdtempSync(join(tmpdir(), "gumply-export-perf-"));
const config = { root: webRoot, configFile: join(webRoot, "vite.config.ts"), logLevel: "warn" };
await build({
  ...config,
  build: { outDir, emptyOutDir: true, rollupOptions: { input: { main: join(webRoot, "index.html"), lab: join(webRoot, "board-lab.html") } } },
});
const server = await preview({ ...config, build: { outDir }, preview: { port, strictPort: true } });
const browser = await chromium.launch();
let slow = false;

try {
  for (const seed of seeds) {
    for (const format of ["svg", "png"]) {
      // A fresh page per format, so the first run is a cold export.
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
      await page.goto(`http://localhost:${port}/board-lab.html?seed=${seed}&mix=1&id=export-${seed}-${Date.now()}`);
      await page.waitForSelector(".react-flow__node");
      await page.waitForTimeout(800);
      const times = [];
      for (let run = 0; run < runs; run += 1) {
        // #pypzxe6i: the canvas's export button opens the export dialog; the format is chosen there.
        await page.getByTestId("board-export-button").click();
        await page.getByTestId(`board-export-format-${format}`).check();
        const started = Date.now();
        const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("board-export-confirm").click()]);
        await download.path();
        times.push(Date.now() - started);
      }
      await page.close();
      if (times.some((time) => time >= LIMIT_MS)) slow = true;
      console.log(`${String(seed).padStart(5)} objects  ${format.toUpperCase()}  cold ${times[0]} ms  warm ${times.slice(1).join(" / ") || "-"} ms`);
    }
  }
} finally {
  await browser.close();
  await server.close();
  rmSync(outDir, { recursive: true, force: true });
}
if (check && slow) {
  console.error(`An export took ${LIMIT_MS} ms or more.`);
  process.exit(1);
}
