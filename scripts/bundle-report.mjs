#!/usr/bin/env node
/**
 * Bundle composition of the web app: builds apps/web in memory (nothing is
 * written) and prints each chunk's size, gzip size and its biggest packages.
 *
 *   node scripts/bundle-report.mjs [--top 20]
 */
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const topIndex = process.argv.indexOf("--top");
const top = topIndex > 0 ? Number(process.argv[topIndex + 1]) : 15;
const root = fileURLToPath(new URL("../apps/web/", import.meta.url));

function groupOf(id) {
  const nm = id.lastIndexOf("node_modules/");
  if (nm >= 0) {
    const parts = id.slice(nm + "node_modules/".length).split("/");
    return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
  }
  const m = id.match(/(apps|packages)\/(.*)\/[^/]+$/);
  return m ? `${m[1]}/${m[2]}/` : id;
}

const kb = (n) => `${(n / 1024).toFixed(1).padStart(7)} kB`;

await build({
  root,
  logLevel: "silent",
  build: { write: false },
  plugins: [
    {
      name: "gumply-bundle-report",
      generateBundle(_options, bundle) {
        const chunks = Object.values(bundle).filter((c) => c.type === "chunk");
        chunks.sort((a, b) => b.code.length - a.code.length);
        for (const chunk of chunks) {
          const gz = gzipSync(chunk.code).length;
          console.log(`\n${chunk.fileName}${chunk.isEntry ? " (entry)" : ""}: ${kb(chunk.code.length)}, gzip ${kb(gz)}`);
          const groups = new Map();
          for (const [id, mod] of Object.entries(chunk.modules)) {
            const key = groupOf(id);
            groups.set(key, (groups.get(key) ?? 0) + mod.renderedLength);
          }
          for (const [key, size] of [...groups].sort((a, b) => b[1] - a[1]).slice(0, top)) {
            console.log(`  ${kb(size)}  ${key}`);
          }
        }
      },
    },
  ],
});
