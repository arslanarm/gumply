#!/usr/bin/env node
// A4 (#545fyq48): start Gumply's MCP server exactly as a Claude Desktop
// snippet says, the way Claude Desktop does (no login shell, a bare PATH), and
// walk the flows a user hits: initialize, tools/list, read, a refused write at
// `read`, raise to `append` through Settings (PUT /api/mcp/settings), a write,
// then lower to `read` mid-session and see the next write refused.
//
// Usage:
//   node apps/mcp/scripts/client-check.mjs --snippet <snippet.json> --api <http://127.0.0.1:PORT/api> [--page <id>]
// <snippet.json> is the "Claude Desktop" block from Settings → AI apps, saved as is.
// The vault must be the one the app at --api serves. Exit code 0 = every step passed.
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};
const snippetPath = option("--snippet");
const api = option("--api");
const pageId = option("--page") ?? "Welcome";
if (!snippetPath || !api) {
  process.stderr.write("Usage: client-check.mjs --snippet <snippet.json> --api <http://127.0.0.1:PORT/api> [--page <id>]\n");
  process.exit(2);
}

const snippet = JSON.parse(readFileSync(snippetPath, "utf8"));
const [[name, entry]] = Object.entries(snippet.mcpServers);
const log = (line) => process.stdout.write(`${line}\n`);
let failures = 0;
const check = (label, ok, detail = "") => {
  log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures += 1;
};

log(`server "${name}": ${JSON.stringify([entry.command, ...entry.args])}`);
// What Claude Desktop gives a server it starts: no user PATH (no nvm, no ~/.local/bin).
const env = { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
for (const key of ["DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "APPIMAGE_EXTRACT_AND_RUN"]) {
  if (process.env[key]) env[key] = process.env[key];
}

async function connect() {
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client({ name: "gumply-a4-check", version: "1.0.0" });
  const started = Date.now();
  await client.connect(transport);
  return { client, stderr: () => stderr, ms: Date.now() - started };
}

const setAccess = async (access) => {
  const response = await fetch(`${api}/mcp/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, access }),
  });
  check(`Settings → access "${access}" (PUT /api/mcp/settings)`, response.ok, String(response.status));
};

const call = (client, tool, input) => client.callTool({ name: tool, arguments: input });
const codeOf = (result) => result.structuredContent?.code ?? result.structuredContent?.error?.code ?? (result.content?.[0]?.text ?? "").slice(0, 80);

try {
  await setAccess("read");
  let session = await connect();
  const info = session.client.getServerVersion();
  check("initialize", Boolean(info), `${info?.name} ${info?.version} in ${session.ms} ms`);
  let tools = (await session.client.listTools()).tools.map((tool) => tool.name).sort();
  check("tools/list at read: read tools only", tools.includes("read") && !tools.includes("append_to_page"), tools.join(", "));
  const page = await call(session.client, "read", { id: pageId });
  check(`read "${pageId}"`, !page.isError && typeof page.structuredContent?.content === "string", `${String(page.structuredContent?.content ?? "").length} chars`);
  const refused = await call(session.client, "append_to_page", { id: pageId, markdown: "Should not be written." }).catch((error) => ({ isError: true, content: [{ text: String(error.message) }] }));
  check("append_to_page at read is refused", refused.isError === true, codeOf(refused));
  await session.client.close();

  await setAccess("append");
  session = await connect();
  tools = (await session.client.listTools()).tools.map((tool) => tool.name).sort();
  check("tools/list at append: the add tools appear", tools.includes("append_to_page") && tools.includes("create_page") && !tools.includes("trash_page"), tools.join(", "));
  const marker = `Added by the A4 client check (${new Date().toISOString()}).`;
  const appended = await call(session.client, "append_to_page", { id: pageId, markdown: marker });
  check("append_to_page at append", !appended.isError, JSON.stringify(appended.structuredContent ?? {}));
  const after = await call(session.client, "read", { id: pageId });
  check("the text is on the page", String(after.structuredContent?.content ?? "").includes(marker));

  // Lowering takes effect at once, without reconnecting (the server reads mcp.json on every write).
  await setAccess("read");
  const lowered = await call(session.client, "append_to_page", { id: pageId, markdown: "Should not be written either." });
  check("after lowering to read mid-session, the next write is refused", lowered.isError === true, codeOf(lowered));
  await session.client.close();
  if (session.stderr().trim()) log(`server stderr (last 400 chars): ${session.stderr().trim().slice(-400)}`);
} catch (error) {
  check("no exception", false, error instanceof Error ? error.stack ?? error.message : String(error));
}

log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
