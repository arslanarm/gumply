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
    expect(Object.values(all)).toContain(OUTSIDE);
    expect(Object.values(all)).toContain(MINE);
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
});
