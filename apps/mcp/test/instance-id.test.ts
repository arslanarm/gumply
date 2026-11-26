/**
 * #vduteee7 (from #ddqd664r): `gumply mcp` runs its own `VaultStore` on the vault. A rename it starts is journalled
 * under its installation's id (`.gumply/rename-pending.json`), and the app finishes only its own installation's
 * pending renames at once (another installation's wait 7 days). So the MCP process must be the app's installation:
 * a rename an MCP process left half done (it crashed or was killed) is finished when the app opens the vault, and
 * no link is left `[[Old]]` for a week. Synthetic vault.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultStore } from "../../server/src/vault-store.js";
import { instanceIdIn } from "../../server/src/instance-id.js";
import { Vault } from "../src/vault.js";

describe("a rename an MCP process left half done is finished by the app (#vduteee7)", { timeout: 60_000 }, () => {
  let base = "";
  let dir = "";
  let state = "";

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "gumply-mcp-instance-"));
    dir = join(base, "vault");
    state = join(base, "state");
    mkdirSync(join(dir, "L"), { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(dir, "Hub.md"), "The hub.\n");
    for (let i = 0; i < 600; i += 1) writeFileSync(join(dir, "L", `Linker ${i}.md`), `See [[Hub]] (${i}).\n`);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it("the app's store (the same installation's id) finishes it at once", async () => {
    // The installation's id, as the desktop app keeps it (its userData folder).
    const installation = () => instanceIdIn(state);

    // The MCP process starts a rename and dies after its first batch: the file is renamed, most links aren't.
    const mcp = new Vault(dir, installation());
    await mcp.open();
    mcp.close();
    let died = false;
    mcp.store.afterRenameBatch = async () => {
      if (died) return;
      died = true;
      throw new Error("the MCP process was killed (test)");
    };
    await mcp.store.update("Hub", { title: "Hub renamed" }).catch(() => undefined);
    expect(died, "the rename was cut short after a batch").toBe(true);

    // The app opens the vault: one installation, so it finishes the rename now (not in 7 days).
    const app = new VaultStore(dir, { instanceId: installation() });
    await app.init();
    await app.renamesResumed;

    const left = readdirSync(join(dir, "L")).filter((name) => !readFileSync(join(dir, "L", name), "utf8").includes("[[Hub renamed]]"));
    expect(left, "pages still linking [[Hub]]").toEqual([]);
  });
});
