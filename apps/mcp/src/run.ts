/**
 * The MCP server over stdio for one vault (spec/mcp §1), as a function: the
 * `gumply mcp` bin (cli.ts) and the desktop app's `--mcp` mode (A3) both run
 * it. Stdout carries MCP only; every log line goes to stderr. The process
 * exits when stdin closes.
 */
import { statSync } from "node:fs";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RateLimiter } from "./limits.js";
import { createServer } from "./server.js";
import { effectiveAccess, readSettings } from "./settings.js";
import { Vault } from "./vault.js";

export interface RunMcpOptions {
  /** An absolute vault path. */
  vault: string;
  readOnly: boolean;
  /** Ends the process (tests and the desktop app pass their own). */
  exit?: (code: number) => never;
  /** #6bxm6ygf: `serverInfo.version` (the desktop app's own); default `SERVER_VERSION`. */
  version?: string;
}

/** Point every console method at stderr: stdout is the protocol. */
export function protectStdout(): void {
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  console.debug = console.error;
}

export function runMcp(options: RunMcpOptions): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const fail = (message: string, code = 1): never => {
    process.stderr.write(`${message}\n`);
    return exit(code);
  };
  protectStdout();

  // A missing vault is an error; it is never created.
  let isDir = false;
  try {
    isDir = statSync(options.vault).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) fail(`No vault folder at ${options.vault}`);

  const settings = readSettings(options.vault);
  if (!settings.enabled) fail("MCP is turned off for this vault (Gumply → Settings → AI apps (MCP))");
  const access = effectiveAccess(settings, options.readOnly);

  const vault = new Vault(options.vault);
  // Index in the background: the handshake and tools/list don't wait for it.
  vault.open().catch((error: unknown) => fail(`[gumply mcp] can't read the vault: ${error instanceof Error ? error.message : String(error)}`));
  const limiter = new RateLimiter(
    Number(process.env.GUMPLY_MCP_WRITES_PER_MINUTE) || 30,
    Number(process.env.GUMPLY_MCP_WRITES_PER_DAY) || 1000,
  );
  const logMaxBytes = Number(process.env.GUMPLY_MCP_LOG_MAX_BYTES) || 5 * 1024 * 1024;

  const handle = serveStdio(() => createServer({ vault, access, write: { readOnly: options.readOnly, limiter, logMaxBytes }, ...(options.version ? { version: options.version } : {}) }), {
    onerror: (error) => console.error("[gumply mcp]", error.message),
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    vault.close();
    void handle.close().finally(() => {
      // Let queued writes finish, then go: watchers are closed, so nothing keeps us alive.
      void vault.ready.then(() => vault.store.rescan()).finally(() => exit(0));
    });
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.error(`[gumply mcp] serving ${options.vault} (${access})`);
}
