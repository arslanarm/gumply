import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupVaults, createTestServer } from "./helpers";

/**
 * #e3mwuspu (follow-up of #bfy92cu6): a page rename or move checks that the new name is free, then moves the file.
 * `rename()` would replace a file another app (Obsidian, a sync tool) saved at that name in between; the move must
 * never replace it. Forced deterministically: the outside file is written just before the move (`rename`, or
 * `link` for a move that mustn't replace). A case-only rename still works. Synthetic vault.
 */

const outside = vi.hoisted(() => ({ before: null as null | { target: string; text: string } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const outsideFirst = async (to: unknown) => {
    const plan = outside.before;
    if (!plan || !String(to).endsWith(plan.target)) return;
    outside.before = null;
    await actual.writeFile(String(to), plan.text, "utf8");
  };
  const rename: typeof actual.rename = async (from, to) => {
    await outsideFirst(to);
    return actual.rename(from, to);
  };
  const link: typeof actual.link = async (from, to) => {
    await outsideFirst(to);
    return actual.link(from, to);
  };
  return { ...actual, rename, link, default: { ...actual, rename, link } };
});

beforeEach(() => {
  outside.before = null;
});
afterEach(async () => {
  outside.before = null;
  await cleanupVaults();
});

const OUTSIDE = "Written in another app.\n";
const MINE = "My notes.\n";

/** Every Markdown file under `dir` (relative path → text). */
async function files(dir: string, prefix = ""): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) Object.assign(out, await files(dir, rel));
    else if (entry.name.endsWith(".md")) out[rel] = await readFile(join(dir, rel), "utf8");
  }
  return out;
}

async function vault() {
  const server = await createTestServer();
  await writeFile(join(server.dir, "Draft.md"), MINE, "utf8");
  await mkdir(join(server.dir, "Archive"), { recursive: true });
  await writeFile(join(server.dir, "Archive", "Index.md"), "Index\n", "utf8");
  await server.store.rescan();
  return server;
}

describe("a page rename or move never replaces a file another app just made at the new name (#e3mwuspu)", () => {
  it("rename (Draft → Final)", async () => {
    const { dir, store } = await vault();
    outside.before = { target: "Final.md", text: OUTSIDE };
    await store.update("Draft", { title: "Final" }).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    const all = await files(dir);
    expect(all["Final.md"]).toBe(OUTSIDE);
    expect(Object.values(all)).toContain(MINE);
  });

  it("rename: the page takes the next free name (\"Final 2\") rather than being left half renamed", async () => {
    const { dir, store } = await vault();
    outside.before = { target: "Final.md", text: OUTSIDE };
    const renamed = await store.update("Draft", { title: "Final" });
    expect(renamed.id).toBe("Final 2");
    const all = await files(dir);
    expect(all["Final.md"]).toBe(OUTSIDE);
    expect(all["Final 2.md"]).toContain("My notes.");
    expect(all["Draft.md"]).toBeUndefined();
    // The rename chain's first step (#ber4hvce) sits under the name the rename ended at, not the taken one
    // (another app's file now) (@opus-editor's nit, @lead).
    const chains = (store as unknown as { renameRewrites: Map<string, unknown[]> }).renameRewrites;
    expect(chains.has("Final 2")).toBe(true);
    expect(chains.has("Final")).toBe(false);
  });

  it("move (Draft → Archive/Draft)", async () => {
    const { dir, store } = await vault();
    outside.before = { target: join("Archive", "Draft.md"), text: OUTSIDE };
    await store.move("Draft", "Archive").catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    const all = await files(dir);
    expect(Object.values(all)).toContain(OUTSIDE);
    expect(Object.values(all)).toContain(MINE);
  });

  it("a case-only rename (Draft → DRAFT) still renames, bytes kept", async () => {
    const { dir, store } = await vault();
    await store.update("Draft", { title: "DRAFT" });
    const all = await files(dir);
    expect(Object.values(all)).toEqual(expect.arrayContaining([MINE]));
    expect(store.list().some((meta) => meta.id === "DRAFT")).toBe(true);
  });

  it("case-sensitive file system: a case-only rename (Draft → DRAFT) never replaces another app's DRAFT.md (@lead)", async () => {
    const { dir, store } = await vault();
    // Only where `Draft.md` and `DRAFT.md` are two files (Linux; skipped on macOS/Windows volumes).
    await writeFile(join(dir, "draft-probe.md"), "", "utf8");
    const { access, rm } = await import("node:fs/promises");
    const caseSensitive = await access(join(dir, "DRAFT-PROBE.md")).then(() => false, () => true);
    await rm(join(dir, "draft-probe.md"));
    if (!caseSensitive) return;
    outside.before = { target: "DRAFT.md", text: OUTSIDE };
    await store.update("Draft", { title: "DRAFT" }).catch(() => undefined);
    expect(outside.before, "the move was reached").toBeNull();
    const all = await files(dir);
    expect(all["DRAFT.md"]).toBe(OUTSIDE);
    expect(Object.values(all).some((text) => text.includes("My notes."))).toBe(true);
  });
});
