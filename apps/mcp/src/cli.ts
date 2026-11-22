/**
 * `gumply mcp --vault <path> [--read-only]` (spec/mcp §1): an MCP server over
 * stdio for one vault. Stdout carries MCP only; every log line goes to
 * stderr. It exits when stdin closes.
 */
import { resolve } from "node:path";
import { protectStdout, runMcp } from "./run.js";

// Stdout is the protocol: anything the store (or a dependency) logs goes to stderr.
protectStdout();

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

try {
  runMcp(parseArgs(process.argv.slice(2)));
} catch (error: unknown) {
  fail(`[gumply mcp] ${error instanceof Error ? error.message : String(error)}`);
}
