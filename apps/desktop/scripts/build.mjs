// Build the desktop app: bundle the main process (server + core included) with
// esbuild into dist/main.mjs and copy the built web app to dist/web.
// Usage: node scripts/build.mjs   (from apps/desktop, or via npm scripts)
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, "..");
const repo = join(desktop, "..", "..");
const dist = join(desktop, "dist");
const require = createRequire(import.meta.url);

// npm may skip install scripts until approved; make sure Electron's binary is there.
try {
  require("electron");
} catch {
  console.log("[desktop] fetching the Electron binary…");
  execSync("node install.js", { cwd: dirname(require.resolve("electron/package.json")), stdio: "inherit" });
}

if (process.env.GUMPLY_DESKTOP_SKIP_WEB !== "1") {
  console.log("[desktop] building the web app…");
  execSync("npm run build -w @gumply/web", { cwd: repo, stdio: "inherit" });
}
if (!existsSync(join(repo, "apps/web/dist/index.html"))) throw new Error("apps/web/dist is missing");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [join(desktop, "src/main.ts")],
  outfile: join(dist, "main.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["electron"],
  // A map file for local debugging, but no `sourceMappingURL` in the shipped
  // bundle: the map itself is never packaged.
  sourcemap: "external",
  // Core and server from source: no separate build step, one file to ship.
  alias: { "@gumply/core": join(repo, "packages/core/src/index.ts") },
  // Bundled CommonJS dependencies may still call require().
  banner: { js: "import { createRequire as __gumplyRequire } from 'node:module'; const require = __gumplyRequire(import.meta.url);" },
  logLevel: "warning",
});
cpSync(join(repo, "apps/web/dist"), join(dist, "web"), { recursive: true });
console.log("[desktop] built dist/main.mjs and dist/web");
