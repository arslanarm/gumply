#!/usr/bin/env node
/**
 * Seed a throwaway vault for graph performance checks (M3).
 *
 *   npm run seed:big            # 200 pages
 *   npm run seed:big -- 500     # more
 *   GUMPLY_API_URL=http://localhost:8787/api npm run seed:big
 *
 * Creates one root page ("Big Vault") and N sub-pages, each linking to the
 * next page and a few others. Every 13th page also links to a missing title
 * so ghost nodes show up.
 */

const base = (process.env.GUMPLY_API_URL ?? "http://localhost:8787/api").replace(/\/+$/, "");
const count = Number.parseInt(process.argv[2] ?? "200", 10);

if (!Number.isInteger(count) || count < 1 || count > 2000) {
  console.error("Usage: node scripts/seed-big.mjs [1..2000]");
  process.exit(1);
}

async function request(path, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${body}`);
  }
  return response.status === 204 ? undefined : response.json();
}

const root = await request("/pages", {
  method: "POST",
  body: JSON.stringify({ title: "Big Vault", icon: "🧪" }),
});

function contentFor(index) {
  const links = [`[[Page ${(index % count) + 1}]]`, `[[Page ${((index + 7) % count) + 1}]]`];
  if (index % 13 === 0) links.push(`[[Missing topic ${index}]]`);
  return [
    `# Page ${index}`,
    "",
    `Seeded page ${index} of ${count}.`,
    "",
    `Related: ${links.join(" ")}`,
    "",
    `#seed ${index % 5 === 0 ? "#demo" : ""}`.trim(),
  ].join("\n");
}

const concurrency = 8;
let created = 0;

while (created < count) {
  const batch = [];
  for (let offset = 0; offset < concurrency && created + offset < count; offset += 1) {
    const index = created + offset + 1;
    batch.push(
      request("/pages", {
        method: "POST",
        body: JSON.stringify({
          title: `Page ${index}`,
          parentId: root.id,
          content: contentFor(index),
        }),
      }),
    );
  }
  await Promise.all(batch);
  created += batch.length;
  process.stdout.write(`\rcreated ${created}/${count} pages`);
}

const graph = await request("/graph");
console.log(
  `\nDone: ${graph.nodes.length} pages, ${graph.links.length} links, ${graph.unresolved.length} missing refs.`,
);
console.log(`Open http://localhost:5173/#graph (vault: ${process.env.GUMPLY_VAULT ?? "./vault"})`);
