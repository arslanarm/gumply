/**
 * #429bvzwr: `runMcp` can serve on streams it's given instead of
 * `process.stdin`/`stdout`. The desktop app passes streams over fds 0/1 on
 * Windows, where a GUI-subsystem exe's `process.stdout` can be a black hole.
 */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runMcp } from "../src/run.js";
import { makeVault } from "./harness.js";

let fixture: ReturnType<typeof makeVault> | null = null;
const consoleBefore = { log: console.log, info: console.info, warn: console.warn, debug: console.debug };
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  Object.assign(console, consoleBefore); // runMcp points console at stderr
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("runMcp on given streams (#429bvzwr)", () => {
  it("answers initialize on the given stdout, and ends with exit 0 when the given stdin closes", async () => {
    fixture = makeVault();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let written = "";
    stdout.on("data", (chunk: Buffer) => (written += chunk.toString()));
    let exited: number | null = null;
    const exit = ((code: number) => {
      exited = code;
    }) as (code: number) => never;

    runMcp({ vault: fixture.dir, readOnly: true, exit, version: "9.9.9-test", stdio: { stdin, stdout } });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`,
    );
    await expect.poll(() => written, { timeout: 10_000 }).toContain('"serverInfo"');
    const answer = JSON.parse(written.split("\n")[0]!) as { id: number; result: { serverInfo: { name: string; version: string } } };
    expect(answer.id).toBe(1);
    expect(answer.result.serverInfo).toEqual({ name: "gumply", version: "9.9.9-test" });

    stdin.end();
    await expect.poll(() => exited, { timeout: 10_000 }).toBe(0);
  });
});
