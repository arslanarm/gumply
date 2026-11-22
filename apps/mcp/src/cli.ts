/**
 * `gumply mcp --vault <path> [--read-only]` (spec/mcp §1): an MCP server over
 * stdio for one vault. Stdout carries MCP only; every log line goes to
 * stderr. It exits when stdin closes.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { RateLimiter } from "./limits.js";
import { createServer } from "./server.js";
import { effectiveAccess, readSettings } from "./settings.js";
import { Vault } from "./vault.js";

// Stdout is the protocol: anything the store (or a dependency) logs goes to stderr.
console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

const USAGE = "Usage: gumply mcp --vault <path> [--read-only]";

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): { vault: string; readOnly: boolean } {
  const [command, ...rest] = argv;
  if (command !== "mcp") fail(USAGE, 2);
  let vault: string | undefined;
  let readOnly = false;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!;
    if (arg === "--vault") vault = rest[++index];
    else if (arg.startsWith("--vault=")) vault = arg.slice("--vault=".length);
    else if (arg === "--read-only") readOnly = true;
    else fail(`Unknown option: ${arg}\n${USAGE}`, 2);
  }
  if (!vault) fail(`--vault is required.\n${USAGE}`, 2);
  return { vault: resolve(vault), readOnly };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // A missing vault is an error; it is never created.
  let isDir = false;
  try {
    isDir = statSync(args.vault).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) fail(`No vault folder at ${args.vault}`);

  const settings = readSettings(args.vault);
  if (!settings.enabled) fail("MCP is turned off for this vault (Gumply → Settings → MCP)");
  const access = effectiveAccess(settings, args.readOnly);

  const vault = new Vault(args.vault);
  await vault.open();
  const limiter = new RateLimiter(
    Number(process.env.GUMPLY_MCP_WRITES_PER_MINUTE) || 30,
    Number(process.env.GUMPLY_MCP_WRITES_PER_DAY) || 1000,
  );
  const logMaxBytes = Number(process.env.GUMPLY_MCP_LOG_MAX_BYTES) || 5 * 1024 * 1024;

  const handle = serveStdio(() => createServer({ vault, access, write: { readOnly: args.readOnly, limiter, logMaxBytes } }), {
    onerror: (error) => console.error("[gumply mcp]", error.message),
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    vault.close();
    void handle.close().finally(() => {
      // Let queued writes finish, then go: watchers are closed, so nothing keeps us alive.
      void vault.store.rescan().finally(() => process.exit(0));
    });
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  console.error(`[gumply mcp] serving ${args.vault} (${access})`);
}

main().catch((error: unknown) => fail(`[gumply mcp] ${error instanceof Error ? error.message : String(error)}`));
