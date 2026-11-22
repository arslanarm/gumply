/**
 * Server timings on a big vault (#g95wkd9y, dev/performance-budget).
 *
 *   npx tsx scripts/perf/measure-server.ts <vault> [--runs 7] [--json out.json]
 *
 * Runs the API in-process (Hono `app.request`, no sockets) against a COPY you
 * pass in: it writes to the vault (saves, outside edits for the rescans).
 * Make one with scripts/perf/make-vault.mjs. Reports the median of --runs
 * (after one warm-up) per operation, plus response sizes and heap.
 * One heavy run at a time; numbers on a busy machine are only comparable
 * within the same session.
 */
import { appendFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { createApp } from "../../apps/server/src/app.js";
import { VaultStore } from "../../apps/server/src/vault-store.js";

const args = process.argv.slice(2);
const vault = args.find((arg) => !arg.startsWith("--"));
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const RUNS = Number(option("runs", "7"));
const jsonOut = option("json", "");
if (!vault) {
  console.error("usage: npx tsx scripts/perf/measure-server.ts <vault copy> [--runs 7] [--json out.json]");
  process.exit(2);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};
const rows: Array<{ metric: string; ms: number; detail: string }> = [];
const report = (metric: string, ms: number, detail = "") => {
  rows.push({ metric, ms: Math.round(ms * 10) / 10, detail });
  console.log(`${metric.padEnd(44)} ${ms.toFixed(1).padStart(9)} ms  ${detail}`);
};

async function timed<T>(run: () => Promise<T>, runs = RUNS): Promise<{ ms: number; last: T }> {
  let last = await run(); // warm-up
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    last = await run();
    times.push(performance.now() - start);
  }
  return { ms: median(times), last };
}

function markdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

// --- cold open ---------------------------------------------------------------
{
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    const store = new VaultStore(vault);
    await store.init();
    times.push(performance.now() - start);
  }
  report("cold open: VaultStore.init (scan + index)", times[0]!, `first run; then ${times.slice(1).map((t) => t.toFixed(0)).join(", ")} ms (OS cache warm)`);
}

const store = new VaultStore(vault);
await store.init();
const app = createApp({ vaultPath: vault, store });
const heap = process.memoryUsage().heapUsed / 1024 / 1024;
report("heap after init", 0, `${heap.toFixed(0)} MB`);

const get = async (path: string) => {
  const response = await app.request(`http://127.0.0.1/api${path}`);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.text();
};
const sized = async (metric: string, path: string) => {
  const { ms, last } = await timed(() => get(path));
  report(metric, ms, `${(last.length / 1024).toFixed(0)} KB`);
  return last;
};

const pagesText = await sized("GET /pages (sidebar tree)", "/pages");
const pages = JSON.parse(pagesText) as Array<{ id: string; kind?: string }>;
report("pages in the vault", 0, `${pages.length} items`);
await sized("GET /pages?include=properties", "/pages?include=properties");
await sized("GET /graph (global)", "/graph");
await sized("GET /graph?center=Hub&depth=1 (local)", "/graph?center=Hub&depth=1");
await sized("GET /tags", "/tags");
await sized("GET /search?q=roadmap (common word)", "/search?q=roadmap");
await sized("GET /search?q=xylo yonder (two words)", `/search?q=${encodeURIComponent("xylo yonder")}`);
await sized("GET /search?q=Missing 4 (title-ish, rare)", `/search?q=${encodeURIComponent("Missing 4")}`);
await sized("GET /pages/Hub/backlinks", "/pages/Hub/backlinks");
await sized("GET /pages/Hub/mentions (unlinked)", "/pages/Hub/mentions");
const somePage = pages.find((page) => (page.kind ?? "page") === "page" && page.id.includes("/Topic 3/"))!;
await sized("GET /pages/:id (one page)", `/pages/${encodeURIComponent(somePage.id)}`);
await sized("GET /boards/:id (1,000-object board)", `/boards/${encodeURIComponent("Boards/Big board.canvas")}`);
await sized("GET /bases/:id/view (a table over the vault)", `/bases/${encodeURIComponent("Views/View 0.base")}/view?name=${encodeURIComponent("Table 0")}`);

// --- saves -----------------------------------------------------------------------
{
  let page = JSON.parse(await get(`/pages/${encodeURIComponent(somePage.id)}`)) as { id: string; content: string; updated: string };
  let n = 0;
  const { ms } = await timed(async () => {
    const response = await app.request(`http://127.0.0.1/api/pages/${encodeURIComponent(page.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `${page.content}\nEdit ${n++}.`, expectedUpdated: page.updated }),
    });
    if (!response.ok) throw new Error(`save: ${response.status} ${await response.text()}`);
    page = (await response.json()) as typeof page;
  }, 20);
  report("PUT /pages/:id (save a body edit)", ms, "median of 20");
}

// --- outside changes, then a rescan ------------------------------------------------
const files = markdownFiles(vault).filter((file) => !relative(vault, file).startsWith("Hub"));
for (const changes of [1, 500]) {
  const times: number[] = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < changes; i++) appendFileSync(files[(round * 997 + i * 13) % files.length]!, `\nOutside edit ${round}-${i}.\n`);
    const start = performance.now();
    await store.rescan();
    times.push(performance.now() - start);
  }
  report(`rescan after ${changes} outside change${changes > 1 ? "s" : ""}`, median(times), "median of 3");
}
{
  const start = performance.now();
  await store.rescan();
  report("rescan with nothing changed", performance.now() - start);
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ vault, runs: RUNS, rows }, null, 2)}\n`);
