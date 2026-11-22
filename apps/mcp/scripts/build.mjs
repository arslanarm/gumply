// Build the MCP bin: bundle src/cli.ts (server's VaultStore and core included,
// from source) with esbuild into one dist/gumply.mjs, like apps/desktop.
// Usage: node scripts/build.mjs [--out <file>]   (tests bundle to a temp file)
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, "..");
const repo = join(app, "..", "..");
const dist = join(app, "dist");

const outArg = process.argv.indexOf("--out");
const outfile = outArg === -1 ? join(dist, "gumply.mjs") : process.argv[outArg + 1];
if (outArg === -1) rmSync(dist, { recursive: true, force: true });
mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(app, "src/cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "external",
  alias: { "@gumply/core": join(repo, "packages/core/src/index.ts") },
  // Bundled CommonJS dependencies may still call require().
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __gumplyRequire } from 'node:module'; const require = __gumplyRequire(import.meta.url);" },
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
console.error(`[mcp] built ${outfile}`);
