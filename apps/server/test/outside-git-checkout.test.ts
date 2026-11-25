import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VaultStore } from "../src/vault-store";
import { trackStore, drainStores } from "./helpers";

/**
 * #35q6kt6e (@opus-hunter's P1): `git checkout` in a watched vault removes,
 * renames and rewrites files while the watcher's rescans run. The server must
 * survive it (no unhandled rejection: Vitest fails the run on one) and end up
 * with the checked-out tree. Skipped where git isn't installed.
 */
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let vault: string | null = null;
let store: VaultStore | null = null;
afterEach(async () => {
  store?.stopWatching();
  store = null;
  await drainStores();
  if (vault) rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  vault = null;
});

describe.skipIf(!hasGit)("a git checkout in the vault (#35q6kt6e)", () => {
  it("survives checkouts back and forth and ends with each branch's notes", async () => {
    const root = mkdtempSync(join(tmpdir(), "gumply-git-"));
    vault = root;
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdio: "pipe" });
    mkdirSync(join(root, "Repo", "Sub"), { recursive: true });
    for (let i = 0; i < 60; i++) writeFileSync(join(root, "Repo", `Doc ${i}.md`), `Doc ${i} links [[Doc ${(i + 1) % 60}]].\n`);
    for (let i = 0; i < 10; i++) writeFileSync(join(root, "Repo", "Sub", `S ${i}.md`), `Sub ${i} links [[Doc ${i}]].\n`);
    git("init", "-q", "-b", "one");
    git("add", "-A");
    git("commit", "-qm", "one");
    git("checkout", "-qb", "two");
    for (let i = 0; i < 15; i++) git("mv", `Repo/Doc ${i}.md`, `Repo/Moved ${i}.md`);
    for (let i = 15; i < 30; i++) writeFileSync(join(root, "Repo", `Doc ${i}.md`), `Edited ${i} links [[Doc 40]].\n`);
    for (let i = 30; i < 40; i++) git("rm", "-q", `Repo/Doc ${i}.md`);
    for (let i = 0; i < 10; i++) writeFileSync(join(root, "Repo", `New ${i}.md`), `New ${i} links [[Doc 50]].\n`);
    git("mv", "Repo/Sub", "Repo/Sub renamed");
    git("add", "-A");
    git("commit", "-qm", "two");
    git("checkout", "-q", "one");

    store = trackStore(new VaultStore(root));
    await store.init();
    store.startWatching();
    const ids = () => new Set(store!.list().map((meta) => meta.id));
    for (const branch of ["two", "one", "two", "one"]) {
      git("checkout", "-q", branch);
      const onTwo = branch === "two";
      await expect
        .poll(
          () => {
            const now = ids();
            return [now.has("Repo/New 0"), now.has("Repo/Sub renamed/S 0"), now.has("Repo/Sub/S 0"), now.has("Repo/Doc 35"), now.has("Repo/Moved 3")];
          },
          // Generous: under a loaded test run a checkout plus its rescans can take seconds.
          { timeout: 30_000, interval: 100 },
        )
        .toEqual([onTwo, onTwo, !onTwo, !onTwo, onTwo]);
    }
    // Links follow the tree: on branch one, Doc 1 links to Doc 2 again. Polled:
    // a refresh lists its pages before it recomputes their links.
    await expect.poll(() => store!.backlinks("Repo/Doc 2").map((item) => item.page.id), { timeout: 30_000, interval: 100 }).toContain("Repo/Doc 1");
  }, 150_000);

});

describe("a folder that starts being watched late (#35q6kt6e, @opus-hunter's scenario B)", () => {
  it("files written into a new folder after the walk, before its watcher exists, still come in", async () => {
    const root = mkdtempSync(join(tmpdir(), "gumply-late-"));
    vault = root;
    store = trackStore(new VaultStore(root));
    await store.init();
    store.startWatching();
    // Right after a refresh walks the vault (and before the new folder's watcher
    // is attached), a file lands in the new folder: no event can report it.
    const internals = store as unknown as { refreshFromDisk: (...args: unknown[]) => Promise<boolean> };
    const refresh = internals.refreshFromDisk;
    let wroteLate = false;
    internals.refreshFromDisk = async function (this: unknown, ...args: unknown[]) {
      const result = await refresh.apply(this, args);
      if (!wroteLate && existsSync(join(root, "Repo"))) {
        wroteLate = true;
        writeFileSync(join(root, "Repo", "Late.md"), "Written between the walk and the watcher.\n");
      }
      return result;
    };
    mkdirSync(join(root, "Repo"));
    writeFileSync(join(root, "Repo", "Early.md"), "Here before the walk.\n");
    await expect
      .poll(() => store!.list().map((meta) => meta.id).filter((id) => id.startsWith("Repo/")).sort(), { timeout: 10_000, interval: 100 })
      .toEqual(["Repo/Early", "Repo/Late"]);
    expect(wroteLate).toBe(true);
  }, 30_000);
});
