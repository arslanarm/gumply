import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #e3mwuspu (@lead, @opus-editor's nit 2): the no-replace move treats a name "taken" by the **same file** (same
 * inode and device) as a rename of that file, not a clash: a case-only or NFC/NFD-only rename on a file system that
 * folds them (APFS, NTFS). Stubbed: `link` reports EEXIST and `stat` reports one inode for both names, as APFS does
 * for `Café.md` (NFC) and `Café.md` (NFD).
 */

const fake = vi.hoisted(() => ({ linkExists: false, sameInode: null as null | boolean, zeroInode: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const link: typeof actual.link = async (from, to) => {
    if (fake.linkExists) throw Object.assign(new Error("EEXIST: file already exists, link (test)"), { code: "EEXIST" });
    return actual.link(from, to);
  };
  const stat = (async (path: Parameters<typeof actual.stat>[0], options?: Parameters<typeof actual.stat>[1]) => {
    const real = await actual.stat(path, options as never).catch(() => null);
    if (fake.sameInode === null) {
      if (!real) throw Object.assign(new Error("ENOENT (test)"), { code: "ENOENT" });
      return real;
    }
    // Both names answer, with one inode (the same file) or two (another file).
    const base = real ?? (await actual.stat(String(path).replace(/[^/]*$/, ""), options as never));
    const ino = fake.zeroInode ? 0 : fake.sameInode || String(path).endsWith("from.md") ? 4242 : 4343;
    const big = Boolean((options as { bigint?: boolean } | undefined)?.bigint);
    return Object.assign(Object.create(Object.getPrototypeOf(base)), base, { ino: big ? BigInt(ino) : ino, dev: big ? 7n : 7 });
  }) as typeof actual.stat;
  return { ...actual, link, stat, default: { ...actual, link, stat } };
});

const { moveFileNoReplace } = await import("../src/vault-store");

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "gumply-move-"));
  fake.linkExists = false;
  fake.sameInode = null;
  fake.zeroInode = false;
});
afterEach(async () => {
  fake.linkExists = false;
  fake.sameInode = null;
  await rm(dir, { recursive: true, force: true });
});

describe("moveFileNoReplace: the same file under another form of its name is a rename, not a clash (#e3mwuspu)", () => {
  it("EEXIST from the same inode and device (NFC ↔ NFD, case on APFS/NTFS): the file is renamed", async () => {
    await writeFile(join(dir, "from.md"), "Mine.\n", "utf8");
    fake.linkExists = true;
    fake.sameInode = true;
    await moveFileNoReplace(join(dir, "from.md"), join(dir, "to.md"));
    fake.sameInode = null;
    expect(await readFile(join(dir, "to.md"), "utf8")).toBe("Mine.\n");
  });

  it("EEXIST from another file: a clash, nothing moves", async () => {
    await writeFile(join(dir, "from.md"), "Mine.\n", "utf8");
    await writeFile(join(dir, "to.md"), "Theirs.\n", "utf8");
    fake.linkExists = true;
    fake.sameInode = false;
    await expect(moveFileNoReplace(join(dir, "from.md"), join(dir, "to.md"))).rejects.toMatchObject({ code: "EEXIST" });
    fake.sameInode = null;
    expect(await readFile(join(dir, "from.md"), "utf8")).toBe("Mine.\n");
    expect(await readFile(join(dir, "to.md"), "utf8")).toBe("Theirs.\n");
  });

  it("no clash: an ordinary move, the source gone", async () => {
    await writeFile(join(dir, "from.md"), "Mine.\n", "utf8");
    await moveFileNoReplace(join(dir, "from.md"), join(dir, "to.md"));
    expect(await readFile(join(dir, "to.md"), "utf8")).toBe("Mine.\n");
    await expect(readFile(join(dir, "from.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("two hard links to one file (a crash between link and unlink leaves that): the extra name goes, the file is in one place (@opus-editor)", async () => {
    const { link } = await import("node:fs");
    await writeFile(join(dir, "from.md"), "Mine.\n", "utf8");
    await new Promise<void>((resolve, reject) => link(join(dir, "from.md"), join(dir, "to.md"), (error) => (error ? reject(error) : resolve())));
    await moveFileNoReplace(join(dir, "from.md"), join(dir, "to.md"));
    expect(await readFile(join(dir, "to.md"), "utf8")).toBe("Mine.\n");
    await expect(readFile(join(dir, "from.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a mount that reports inode 0 for every file: never taken for the same file, so a clash moves nothing (@opus-editor)", async () => {
    await writeFile(join(dir, "from.md"), "Mine.\n", "utf8");
    await writeFile(join(dir, "to.md"), "Theirs.\n", "utf8");
    fake.linkExists = true;
    fake.sameInode = true;
    fake.zeroInode = true;
    await expect(moveFileNoReplace(join(dir, "from.md"), join(dir, "to.md"))).rejects.toMatchObject({ code: "EEXIST" });
    fake.sameInode = null;
    fake.zeroInode = false;
    expect(await readFile(join(dir, "to.md"), "utf8")).toBe("Theirs.\n");
    expect(await readFile(join(dir, "from.md"), "utf8")).toBe("Mine.\n");
  });
});
