import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageMentions } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/**
 * #35e42m7v, to @opus-hunter's measured Obsidian 1.14.4 table: a link that is
 * a whole vault path wins (`[[Target]]` is the root `Target.md` from anywhere);
 * otherwise a same-named page under the linking note's folder (any depth)
 * wins, then the shortest path. Backlinks, the graph and every writer
 * resolve from the note the link is written in.
 */

afterEach(cleanupVaults);

async function vault(files: Record<string, string>) {
  const server = await createTestServer();
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(server.dir, path, ".."), { recursive: true });
    await writeFile(join(server.dir, path), body, "utf8");
  }
  const store = new VaultStore(server.dir);
  await store.init();
  return { dir: server.dir, store, app: createApp({ vaultPath: server.dir, store }) };
}

const SUB_THREE = "## Goals\n\nUnder Projects.\n";
const OTHER_THREE = "## Goals\n\nIn Other.\n";
const files = {
  "Target.md": "Root.\n",
  "Projects/Target.md": "Projects.\n",
  "Projects/Sub/Three.md": SUB_THREE,
  "Other/Three.md": OTHER_THREE,
  "Projects/A.md": "From Projects: [[Three]], [[Three#Goals]] and [[Target]].\n",
  "B.md": "From the root: [[Three]] and [[Three#Goals]].\n",
};

type Backlink = { page: { id: string } };
const backlinks = async (app: Awaited<ReturnType<typeof vault>>["app"], id: string) =>
  (await getJson<Backlink[]>(app, `/api/pages/${encodeId(id)}/backlinks`)).map((item) => item.page.id).sort();

describe("links resolve as Obsidian 1.14.4 does, from the linking note (#35e42m7v)", () => {
  it("backlinks and graph edges", async () => {
    const { app } = await vault(files);
    // Under Projects/ (any depth) beats the shorter Other/Three from Projects/A…
    expect(await backlinks(app, "Projects/Sub/Three")).toEqual(["Projects/A"]);
    // …and from the root the shortest path wins.
    expect(await backlinks(app, "Other/Three")).toEqual(["B"]);
    // A whole vault path wins outright: [[Target]] is the root Target, even from Projects/.
    expect(await backlinks(app, "Target")).toEqual(["Projects/A"]);
    expect(await backlinks(app, "Projects/Target")).toEqual([]);
    const graph = await getJson<{ links: Array<{ source: string; target: string }> }>(app, "/api/graph");
    expect(graph.links).toEqual(
      expect.arrayContaining([
        { source: "Projects/A", target: "Projects/Sub/Three" },
        { source: "Projects/A", target: "Target" },
        { source: "B", target: "Other/Three" },
      ]),
    );
  });

  it("a heading rename in Projects/Sub/Three rewrites only the links that mean it", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Projects/Sub/Three")}`, {
      content: SUB_THREE.replace("## Goals", "## Aims"),
    });
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Projects/A"]);
    expect(await readFile(join(dir, "Projects/A.md"), "utf8")).toBe("From Projects: [[Three]], [[Three#Aims]] and [[Target]].\n");
    expect(await readFile(join(dir, "B.md"), "utf8")).toBe(files["B.md"]);
  });

  it("a heading rename in Other/Three leaves the Projects note alone", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Other/Three")}`, {
      content: OTHER_THREE.replace("## Goals", "## Aims"),
    });
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["B"]);
    expect(await readFile(join(dir, "B.md"), "utf8")).toBe("From the root: [[Three]] and [[Three#Aims]].\n");
    expect(await readFile(join(dir, "Projects/A.md"), "utf8")).toBe(files["Projects/A.md"]);
  });

  it("renaming Projects/Sub/Three (D12) rewrites the Projects note, not the root one", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Projects/Sub/Three")}`, { title: "Plan" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Projects/A"]);
    const a = await readFile(join(dir, "Projects/A.md"), "utf8");
    expect(a).not.toContain("[[Three");
    expect(a).toContain("Plan");
    expect(a).toContain("[[Target]]");
    expect(await readFile(join(dir, "B.md"), "utf8")).toBe(files["B.md"]);
  });

  it("Link lists the mention from that note; the link it writes is unambiguous anywhere", async () => {
    const { app, dir } = await vault({ ...files, "Projects/Notes.md": "The three of us.\n" });
    const list = await getJson<PageMentions[]>(app, `/api/pages/${encodeId("Projects/Sub/Three")}/mentions`);
    const notes = list.find((entry) => entry.page.id === "Projects/Notes");
    expect(notes?.mentions.map((mention) => mention.text)).toEqual(["three"]);
    const response = await jsonRequest(app, "POST", `/api/pages/${encodeId("Projects/Sub/Three")}/mentions/link`, {
      source: "Projects/Notes",
      expectedUpdated: notes!.updated,
      all: true,
    });
    expect(response.status).toBe(200);
    // Writers keep linkTargetFor's rule (#mp8eadhk, @lead): a shared name gets its
    // path, so the link means the same page from anywhere, even after the note moves.
    expect(await readFile(join(dir, "Projects/Notes.md"), "utf8")).toBe("The [[Projects/Sub/Three|three]] of us.\n");
    expect(await backlinks(app, "Projects/Sub/Three")).toContain("Projects/Notes");
  });
});
