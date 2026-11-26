/**
 * Test harness (spec/mcp §6): bundles the bin once per test file, copies the
 * synthetic fixture vault to a temp folder, and talks to `gumply mcp --vault`
 * over stdio with the real v2 client, as a 2026-07-28 client ("modern") or a
 * legacy 2025-11-25 client ("legacy").
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

export type Era = "modern" | "legacy";
export const ERAS: Era[] = ["modern", "legacy"];

const app = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(app, "test/fixtures/notes");

let built: string | null = null;
/** The bundled bin, built once per test file into a temp folder. */
export function bin(): string {
  if (built) return built;
  const out = join(mkdtempSync(join(tmpdir(), "gumply-mcp-bin-")), "gumply.mjs");
  execFileSync(process.execPath, [join(app, "scripts/build.mjs"), "--out", out], { stdio: "pipe" });
  built = out;
  return out;
}

/**
 * A fresh copy of the fixture vault, plus what git can't hold: a CRLF note
 * and a symlink to a note outside the vault.
 */
export function makeVault(): { dir: string; outside: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "gumply-mcp-"));
  const dir = join(base, "vault");
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, "Crlf.md"), "---\r\ntags: [crlf]\r\n---\r\nLine one\r\nLine two\r\n");
  const outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "Secret.md"), "OUTSIDE THE VAULT: must never be read.\n");
  try {
    symlinkSync(join(outside, "Secret.md"), join(dir, "Escape.md"));
  } catch {
    // No symlinks on this platform: the escape test skips itself.
  }
  return { dir, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

export function writeSettings(dir: string, settings: unknown): void {
  mkdirSync(join(dir, ".gumply"), { recursive: true });
  writeFileSync(join(dir, ".gumply/mcp.json"), JSON.stringify(settings));
}

/** sha256 of every file in the vault (path and bytes), `.gumply/` excepted unless asked. */
export function vaultHash(dir: string, includeGumply = false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const rel = relative(dir, path).split("\\").join("/");
      if (!includeGumply && rel === ".gumply") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out[rel] = createHash("sha256").update(readFileSync(path)).digest("hex");
      else if (entry.isSymbolicLink()) out[rel] = "symlink";
    }
  };
  walk(dir);
  return out;
}

export interface Connection {
  client: Client;
  stderr: () => string;
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  close: () => Promise<void>;
}

export interface ToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: string; text?: string }>;
}

export async function connect(
  vault: string,
  era: Era,
  options: { args?: string[]; env?: Record<string, string>; name?: string } = {},
): Promise<Connection> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin(), "mcp", "--vault", vault, ...(options.args ?? [])],
    // #vduteee7: a fixed installation id, so a test's rename never creates the real state folder (~/.local/state/gumply).
    env: { PATH: process.env.PATH ?? "", GUMPLY_INSTANCE_ID: "mcp-test-instance", ...(options.env ?? {}) },
    stderr: "pipe",
  });
  let err = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const client = new Client(
    { name: options.name ?? `test-${era}`, version: "1.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  );
  await client.connect(transport);
  return {
    client,
    stderr: () => err,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: () => client.close(),
  };
}

/** The structured error code of an `isError` result. */
export function codeOf(result: ToolResult): string | undefined {
  return (result.structuredContent?.error as { code?: string } | undefined)?.code;
}

/** Run the bin with raw stdin; returns its exit code, stdout and stderr. */
export function runRaw(args: string[], input: string, env: Record<string, string> = {}, holdMs = 0, timeoutMs = 15_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin(), ...args], { env: { PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`bin did not exit within ${timeoutMs} ms; stderr: ${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(input);
    setTimeout(() => child.stdin.end(), holdMs);
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
