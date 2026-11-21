import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupVaults, createPage, createTestServer, encodeId, getJson, jsonRequest } from "./helpers";

/**
 * #vi74zw3s: Gumply's header keys (`updated`, `created`, `title`) are never
 * added to an existing note that lacks them. Without `updated:` the version
 * is the file time (D22/v1.8), and conflicts still work.
 */

afterEach(cleanupVaults);

const OBSIDIAN = "---\nstatus: draft\ntags: [x]\n---\nObsidian body.\n";

type Saved = { id: string; content: string; updated: string };

async function put(app: Parameters<typeof jsonRequest>[0], id: string, body: Record<string, unknown>) {
  const response = await jsonRequest(app, "PUT", `/api/pages/${encodeId(id)}`, body);
  return { status: response.status, page: (await response.json()) as Saved };
}

describe("Gumply's header keys on existing notes (#vi74zw3s)", () => {
  it("a body save on an Obsidian note with frontmatter changes only the body bytes", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Draft.md"), OBSIDIAN);
    await store.rescan();
    const loaded = await getJson<Saved>(app, `/api/pages/${encodeId("Draft")}`);

    const first = await put(app, "Draft", { content: "Obsidian body. E.", expectedUpdated: loaded.updated, writer: "tab-a" });
    expect(first.status).toBe(200);
    expect(await readFile(join(dir, "Draft.md"), "utf8")).toBe("---\nstatus: draft\ntags: [x]\n---\nObsidian body. E.\n");

    // The returned version is the file time; the next save with it succeeds.
    const second = await put(app, "Draft", { content: "Obsidian body. E. F.", expectedUpdated: first.page.updated, writer: "tab-a" });
    expect(second.status).toBe(200);
    // v1.8 keepalive: the same writer may send the version its in-flight save replaced.
    const keepalive = await put(app, "Draft", { content: "Obsidian body. E. F. G.", expectedUpdated: first.page.updated, writer: "tab-a" });
    expect(keepalive.status).toBe(200);
    expect(await readFile(join(dir, "Draft.md"), "utf8")).toBe("---\nstatus: draft\ntags: [x]\n---\nObsidian body. E. F. G.\n");

    // An edit made outside Gumply still wins (D22).
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(join(dir, "Draft.md"), "---\nstatus: draft\ntags: [x]\n---\nChanged in Obsidian.\n");
    await store.rescan();
    const stale = await put(app, "Draft", { content: "Mine", expectedUpdated: keepalive.page.updated, writer: "tab-a" });
    expect(stale.status).toBe(409);
  });

  it("a note with title: but no updated: keeps its keys; Gumply's own pages still bump updated", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "ugly-name.md"), "---\ntitle: Pretty Title\n---\nBody\n");
    await store.rescan();
    const loaded = await getJson<Saved>(app, `/api/pages/${encodeId("ugly-name")}`);
    expect((await put(app, "ugly-name", { content: "Body 2", expectedUpdated: loaded.updated })).status).toBe(200);
    expect(await readFile(join(dir, "ugly-name.md"), "utf8")).toBe("---\ntitle: Pretty Title\n---\nBody 2\n");

    const mine = (await createPage(app, { title: "Gumply page", content: "One" })) as unknown as Saved;
    const before = await readFile(join(dir, "Gumply page.md"), "utf8");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await put(app, mine.id, { content: "Two", expectedUpdated: mine.updated })).status).toBe(200);
    const after = await readFile(join(dir, "Gumply page.md"), "utf8");
    expect(after).toMatch(/\nupdated: \d{4}-/);
    expect(after.match(/updated: (.*)/)?.[1]).not.toBe(before.match(/updated: (.*)/)?.[1]);
  });

  it("a rename's link rewrite and a title change never add header keys to an Obsidian note", async () => {
    const { app, dir, store } = await createTestServer();
    await writeFile(join(dir, "Links.md"), "---\nstatus: open\n---\nSee [[Target]].\n");
    await writeFile(join(dir, "Target.md"), "---\naliases: [t]\n---\nTarget body\n");
    await store.rescan();
    const target = await getJson<Saved>(app, `/api/pages/${encodeId("Target")}`);
    const renamed = await put(app, "Target", { title: "Goal", expectedUpdated: target.updated });
    expect(renamed.status).toBe(200);
    expect(renamed.page.id).toBe("Goal");
    // The renamed note: its file name holds the title, so no `title:` is added.
    expect(await readFile(join(dir, "Goal.md"), "utf8")).toBe("---\naliases: [t]\n---\nTarget body\n");
    // The linking note: only the link changed.
    expect(await readFile(join(dir, "Links.md"), "utf8")).toBe("---\nstatus: open\n---\nSee [[Goal]].\n");
  });
});
