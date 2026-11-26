import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../src/vault-store";

/**
 * #ddqd664r (data-safety hunt: MCP and API write paths): `gumply mcp` runs its own `VaultStore` on the vault, and
 * every store finishes a pending rename it finds in `.gumply/rename-pending.json` at start, when the entry is its
 * installation's. Two stores of one installation (two AI apps' MCP processes; both are "local") can then run one
 * rename at once: a second one opening while the first is still rewriting links "resumes" it. The rename must end
 * with every link rewritten and the journal empty, never with `[[Old]]` left in a page. Synthetic vault.
 */
const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("a second store of the same installation opening mid-rename (#ddqd664r)", { timeout: 60_000 }, () => {
  it("leaves no [[Hub]] behind and no pending entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gumply-rename-2proc-"));
    dirs.push(dir);
    await writeFile(join(dir, "Hub.md"), "The hub.\n");
    await mkdir(join(dir, "L"));
    await Promise.all(Array.from({ length: 600 }, (_, i) => writeFile(join(dir, "L", `Linker ${i}.md`), `See [[Hub]] (${i}).\n`)));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = new VaultStore(dir);
    await first.init();
    let second: VaultStore | null = null;
    first.afterRenameBatch = async () => {
      if (second) return;
      // Another process of this installation starts now (an AI app's `gumply mcp`), with the rename half done.
      second = new VaultStore(dir);
      await second.init();
      await second.renamesResumed;
    };
    await first.update("Hub", { title: "Hub renamed" });
    expect(second, "the second store opened mid-rename").not.toBeNull();

    const left: string[] = [];
    for (const name of await readdir(join(dir, "L"))) {
      const text = await readFile(join(dir, "L", name), "utf8");
      if (!text.includes("[[Hub renamed]]") || /\[\[Hub\]\]/.test(text)) left.push(name);
    }
    expect(left, "pages whose link wasn't rewritten").toEqual([]);
    const journal = await readFile(join(dir, ".gumply", "rename-pending.json"), "utf8").catch(() => "[]");
    expect(journal.includes("Hub renamed"), "the pending entry is gone").toBe(false);
  });
});
