/**
 * #6bxm6ygf: `serverInfo.version` is the app's version. The desktop app passes
 * its own (`app.getVersion()`, stamped from the release tag, e.g.
 * `0.8.0-rc.1`); the npm bin reports `CORE_VERSION`.
 */
import { CORE_VERSION } from "@gumply/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/limits.js";
import { createServer } from "../src/server.js";
import { Vault } from "../src/vault.js";
import { makeVault } from "./harness.js";

let fixture: ReturnType<typeof makeVault> | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

async function serverInfo(version?: string) {
  fixture = makeVault();
  const vault = new Vault(fixture.dir);
  await vault.open();
  const server = createServer({
    vault,
    access: "read",
    write: { readOnly: true, limiter: new RateLimiter(), logMaxBytes: 1024 },
    ...(version ? { version } : {}),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "version-test", version: "1.0.0" });
  await client.connect(clientSide);
  const info = client.getServerVersion();
  await client.close();
  return info;
}

describe("serverInfo.version (#6bxm6ygf)", () => {
  it("is the version the app passes (the desktop app's own, stamped from the tag)", async () => {
    expect(await serverInfo("0.8.0-rc.1")).toMatchObject({ name: "gumply", version: "0.8.0-rc.1" });
  });

  it("is CORE_VERSION by default (the npm gumply mcp)", async () => {
    expect(await serverInfo()).toMatchObject({ name: "gumply", version: CORE_VERSION });
  });
});
