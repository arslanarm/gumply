import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandGraphLinks, type GraphData, type IndexedGraphData } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";

/**
 * #g95wkd9y (spec/api v1.32): `GET /graph?links=index` sends links as index
 * pairs. Bytes per link are bounded whatever the page ids look like (counted,
 * not timed), it expands to exactly the default payload, and the default is
 * unchanged.
 */
let dir: string | null = null;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function app(pages: number) {
  dir = mkdtempSync(join(tmpdir(), "gumply-graph-"));
  // Long, nested ids: what makes the default payload big.
  const folder = join(dir, "A rather long area name", "And a topic folder with words");
  mkdirSync(folder, { recursive: true });
  const id = (i: number) => `Quarterly planning notes about the roadmap number ${i}`;
  for (let i = 0; i < pages; i++) {
    writeFileSync(join(folder, `${id(i)}.md`), `[[${id((i + 1) % pages)}]] [[${id((i + 7) % pages)}]] [[Missing ${i % 5}]]\n`);
  }
  const store = new VaultStore(dir);
  await store.init();
  return createApp({ vaultPath: dir, store });
}

async function get<T>(server: Awaited<ReturnType<typeof app>>, path: string): Promise<{ body: T; bytes: number }> {
  const response = await server.request(`http://127.0.0.1/api${path}`);
  const text = await response.text();
  return { body: JSON.parse(text) as T, bytes: text.length };
}

describe("compact graph links (#g95wkd9y, v1.32)", () => {
  it("links cost a few bytes each, however long the page ids are; the default payload is unchanged", async () => {
    const server = await app(120);
    const plain = await get<GraphData>(server, "/graph");
    const indexed = await get<IndexedGraphData>(server, "/graph?links=index");
    expect(plain.body.links.length).toBe(240);
    expect(plain.body.links[0]).toEqual({ source: expect.any(String), target: expect.any(String) });
    expect(indexed.body.linkFormat).toBe("index");
    expect(indexed.body.links).toHaveLength(240);
    const linkBytes = (links: unknown) => JSON.stringify(links).length / 240;
    // Counted bytes: the default spells out two ~110-character paths per link.
    expect(linkBytes(plain.body.links)).toBeGreaterThan(150);
    expect(linkBytes(indexed.body.links)).toBeLessThanOrEqual(12);
    // The whole payload shrinks by what the links lost (here nodes dominate:
    // 2 links per page; the 10k test vault has 12 and goes 14 MB → ~3.5 MB).
    expect(plain.bytes - indexed.bytes).toBeGreaterThan(240 * 140);
    // Everything else is the same.
    expect(indexed.body.nodes).toEqual(plain.body.nodes);
    expect(indexed.body.unresolved).toEqual(plain.body.unresolved);
    expect(indexed.body.tags).toEqual(plain.body.tags);
  });

  it("expanded, the compact form is exactly the default payload (global and local graph)", async () => {
    const server = await app(40);
    for (const query of ["", "center=A rather long area name/And a topic folder with words/Quarterly planning notes about the roadmap number 3&depth=2"]) {
      const plain = await get<GraphData>(server, `/graph${query ? `?${query}` : ""}`);
      const indexed = await get<IndexedGraphData>(server, `/graph?${query ? `${query}&` : ""}links=index`);
      expect(expandGraphLinks(indexed.body)).toEqual(plain.body);
    }
  });

  it("expandGraphLinks passes a default payload through and drops pairs out of range", () => {
    const plain: GraphData = { nodes: [], links: [{ source: "A", target: "B" }], tags: [], unresolved: [] };
    expect(expandGraphLinks(plain)).toBe(plain);
    const node = (id: string) => ({ id, title: id, tags: [], parentId: null, childCount: 0, created: "", updated: "", linkCount: 0 });
    const odd: IndexedGraphData = { nodes: [node("A"), node("B")], links: [[0, 1], [1, 5]], tags: [], unresolved: [], linkFormat: "index" };
    expect(expandGraphLinks(odd).links).toEqual([{ source: "A", target: "B" }]);
  });
});
