import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PageMentions } from "@gumply/core";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/**
 * #35e42m7v: with `Target.md` and `Projects/Target.md` both in the vault, a
 * bare `[[Target]]` means the one in the linking note's own folder, as in
 * Obsidian. Backlinks, the graph and every writer resolve from that note.
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

const TARGET = "## Goals\n\nRoot.\n";
const PROJECT_TARGET = "## Goals\n\nIn Projects.\n";
const files = {
  "Target.md": TARGET,
  "Projects/Target.md": PROJECT_TARGET,
  "Projects/A.md": "From Projects: [[Target]] and [[Target#Goals]].\n",
  "B.md": "From the root: [[Target]] and [[Target#Goals]].\n",
};

type Backlink = { page: { id: string } };
const backlinks = async (app: Awaited<ReturnType<typeof vault>>["app"], id: string) =>
  (await getJson<Backlink[]>(app, `/api/pages/${encodeId(id)}/backlinks`)).map((item) => item.page.id).sort();

describe("links resolve from the linking note's folder (#35e42m7v)", () => {
  it("backlinks and graph edges", async () => {
    const { app } = await vault(files);
    expect(await backlinks(app, "Projects/Target")).toEqual(["Projects/A"]);
    expect(await backlinks(app, "Target")).toEqual(["B"]);
    const graph = await getJson<{ links: Array<{ source: string; target: string }> }>(app, "/api/graph");
    expect(graph.links).toEqual(
      expect.arrayContaining([
        { source: "Projects/A", target: "Projects/Target" },
        { source: "B", target: "Target" },
      ]),
    );
    expect(graph.links).not.toContainEqual({ source: "Projects/A", target: "Target" });
  });

  it("a heading rename in Projects/Target rewrites only the links that mean it", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Projects/Target")}`, {
      content: PROJECT_TARGET.replace("## Goals", "## Aims"),
    });
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Projects/A"]);
    expect(await readFile(join(dir, "Projects/A.md"), "utf8")).toBe("From Projects: [[Target]] and [[Target#Aims]].\n");
    expect(await readFile(join(dir, "B.md"), "utf8")).toBe(files["B.md"]);
  });

  it("a heading rename in the root Target leaves the Projects note alone", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Target")}`, {
      content: TARGET.replace("## Goals", "## Aims"),
    });
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["B"]);
    expect(await readFile(join(dir, "B.md"), "utf8")).toBe("From the root: [[Target]] and [[Target#Aims]].\n");
    expect(await readFile(join(dir, "Projects/A.md"), "utf8")).toBe(files["Projects/A.md"]);
  });

  it("renaming Projects/Target (D12) rewrites the Projects note, not the root one", async () => {
    const { app, dir } = await vault(files);
    const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId("Projects/Target")}`, { title: "Plan" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { rewrittenPages: string[] }).rewrittenPages).toEqual(["Projects/A"]);
    const a = await readFile(join(dir, "Projects/A.md"), "utf8");
    expect(a).not.toContain("[[Target");
    expect(a).toContain("Plan");
    expect(await readFile(join(dir, "B.md"), "utf8")).toBe(files["B.md"]);
  });

  it("Link lists the mention from that note; the link it writes is unambiguous anywhere", async () => {
    const { app, dir } = await vault({ ...files, "Projects/Notes.md": "The target is late.\n" });
    const list = await getJson<PageMentions[]>(app, `/api/pages/${encodeId("Projects/Target")}/mentions`);
    const notes = list.find((entry) => entry.page.id === "Projects/Notes");
    expect(notes?.mentions.map((mention) => mention.text)).toEqual(["target"]);
    const response = await jsonRequest(app, "POST", `/api/pages/${encodeId("Projects/Target")}/mentions/link`, {
      source: "Projects/Notes",
      expectedUpdated: notes!.updated,
      all: true,
    });
    expect(response.status).toBe(200);
    // Writers keep linkTargetFor's rule (#mp8eadhk): a shared name gets its path,
    // so the link means the same page from anywhere, even after the note moves.
    expect(await readFile(join(dir, "Projects/Notes.md"), "utf8")).toBe("The [[Projects/Target|target]] is late.\n");
    expect(await backlinks(app, "Projects/Target")).toContain("Projects/Notes");
  });
});
