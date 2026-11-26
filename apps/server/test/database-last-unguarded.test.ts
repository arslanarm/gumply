import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";
import { cleanupVaults, createTestServer, trackStore } from "./helpers";

/**
 * #f4jkpja6 (from #muw94gvk's audit): the last two writes in the database ops that weren't on the checked paths.
 * (1) A refused paste's own new rows go to the Trash ("nothing deleted outright"), not `rm`.
 * (2) A failed undo's put-back moves the rows it had trashed back with the no-replace move: a file another app made
 *     at a row's name meanwhile is never replaced; that row is named as stuck. Forced: the failure and the outside
 *     file are injected. Synthetic vault.
 */

const inject = vi.hoisted(() => ({ failMoveTo: null as string | null, outsideAt: null as null | { target: string; text: string } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const before = async (to: unknown) => {
    const path = String(to);
    if (path.includes(".trash")) return;
    if (inject.failMoveTo && path.endsWith(inject.failMoveTo)) throw Object.assign(new Error("ENOSPC: no space left (test)"), { code: "ENOSPC" });
    const plan = inject.outsideAt;
    if (plan && path.endsWith(plan.target)) {
      inject.outsideAt = null;
      await actual.writeFile(path, plan.text, "utf8");
    }
  };
  const rename: typeof actual.rename = async (from, to) => {
    await before(to);
    return actual.rename(from, to);
  };
  const link: typeof actual.link = async (from, to) => {
    await before(to);
    return actual.link(from, to);
  };
  const copyFile: typeof actual.copyFile = async (from, to, mode) => {
    await before(to);
    return actual.copyFile(from, to, mode);
  };
  return { ...actual, rename, link, copyFile, default: { ...actual, rename, link, copyFile } };
});

beforeEach(() => {
  inject.failMoveTo = null;
  inject.outsideAt = null;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  inject.failMoveTo = null;
  inject.outsideAt = null;
  vi.restoreAllMocks();
  await cleanupVaults();
});

const BASE = 'gumply:\n  rows: People\nfilters:\n  and:\n    - file.folder == "People"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n';
const OUTSIDE = "---\nrole: Diver\n---\nWritten in another app.\n";

async function database(files: Record<string, string> = {}) {
  const server = await createTestServer();
  await mkdir(join(server.dir, "People"), { recursive: true });
  await writeFile(join(server.dir, "People.base"), BASE, "utf8");
  for (const [path, body] of Object.entries(files)) await writeFile(join(server.dir, path), body, "utf8");
  const store = trackStore(new VaultStore(server.dir));
  await store.init();
  return { dir: server.dir, store };
}

describe("the last two unguarded writes in database ops (#f4jkpja6)", () => {
  it("(1) a refused paste's own new row goes to the Trash, not deleted outright", async () => {
    const { dir, store } = await database();
    // Bo is made; the next new row can't be (its title is too long), so the paste is refused and Bo, made by
    // this paste and unchanged since, is taken back out.
    const result = await store.pasteIntoOwnedRows("People.base", {
      rows: [
        { title: "Bo", set: { role: "Pilot" } },
        { title: "X".repeat(400), set: { role: "Cook" } },
      ],
    });
    expect(result.refused.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, "People", "Bo.md"))).toBe(false);
    const trash = await store.listTrash();
    const ids = trash.flatMap((item) => [item.id, ...item.children.map((child) => child.id)]);
    expect(ids, "the new row is in the Trash").toContain("People/Bo");
  });

  it("(2) a failed undo's put-back never replaces a file another app made at a trashed row's name; that row is named", async () => {
    const { dir, store } = await database();
    const pasted = await store.pasteIntoOwnedRows("People.base", { rows: [{ title: "Bo", set: { role: "Pilot" } }, { title: "Cy", set: { role: "Cook" } }] });
    const made = Object.fromEntries(pasted.made.map((row) => [row.id, row.after]));
    // Cy goes to the Trash by one undo step.
    const first = await store.undoDatabaseChange("People.base", { drop: [{ id: "People/Cy", from: made["People/Cy"]! }] });
    expect(first.refused).toEqual([]);
    const cyTrash = first.dropped[0]!.trashId;
    // The next step drops Bo and brings Cy back; bringing Cy fails, so Bo is put back from the Trash, while
    // another app has just saved a file at Bo's name.
    inject.failMoveTo = join("People", "Cy.md");
    inject.outsideAt = { target: join("People", "Bo.md"), text: OUTSIDE };
    await expect(
      store.undoDatabaseChange("People.base", { drop: [{ id: "People/Bo", from: made["People/Bo"]! }], create: [{ id: "People/Cy", trashId: cyTrash }] }),
    ).rejects.toThrow(/Bo/);
    inject.failMoveTo = null;
    expect(inject.outsideAt, "the move back was reached").toBeNull();
    expect(await readFile(join(dir, "People", "Bo.md"), "utf8")).toBe(OUTSIDE);
  });
});
