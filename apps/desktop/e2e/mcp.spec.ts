import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { _electron as electron, expect, test } from '@playwright/test';

/**
 * v0.8 A3 (spec/mcp §1): `Gumply --mcp --vault <path>` is the stdio MCP
 * server, with no window and no single-instance lock, so the app can run
 * next to it. Build first: `npm run build -w @gumply/desktop`.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electronPath = createRequire(import.meta.url)('electron') as unknown as string;

test.skip(
  process.platform === 'linux' && (process.env.GUMPLY_DESKTOP_HEADLESS !== '1' || !process.env.GUMPLY_TEST_DBUS),
  'Run via `npm run desktop:test` (virtual display + private D-Bus); refusing to touch the real desktop session.',
);

const SESSION_VARS = new Set(['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'DESKTOP_SESSION', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP']);

let scratch: string;
let vault: string;

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gumply-desktop-mcp-'));
  vault = join(scratch, 'vault');
  mkdirSync(vault);
  writeFileSync(join(vault, 'Plan.md'), '# Plan\n\nShip the export.\n');
});
test.afterEach(() => rmSync(scratch, { recursive: true, force: true }));

/** A scratch HOME and XDG dirs, the private bus, and no session variables (P11). */
function isolatedEnv(): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('XDG_') && !SESSION_VARS.has(key)) base[key] = value;
  }
  const home = join(scratch, 'home');
  const dirs = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: join(scratch, 'runtime'),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.env.GUMPLY_TEST_DBUS) base.DBUS_SESSION_BUS_ADDRESS = process.env.GUMPLY_TEST_DBUS;
  return { ...base, ...dirs, GUMPLY_DESKTOP_USER_DATA: join(scratch, 'user-data') };
}

const mcpArgs = (extra: string[] = []) => [appDir, '--ozone-platform=x11', '--mcp', '--vault', vault, ...extra];

async function connect(era: 'modern' | 'legacy') {
  const transport = new StdioClientTransport({ command: electronPath, args: mcpArgs(), env: isolatedEnv(), stderr: 'pipe' });
  const client = new Client({ name: `desktop-${era}`, version: '1.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});
  await client.connect(transport);
  return client;
}

/** Run the app in MCP mode with raw stdio; resolves with its exit code. */
function runRaw(args: string[], closeStdin: boolean): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, args, { env: isolatedEnv() });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`--mcp did not exit within 30 s; stderr: ${stderr}`));
    }, 30_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (closeStdin) setTimeout(() => child.stdin.end(), 1_500);
  });
}

test('answers both MCP revisions over stdio and reads the vault', async () => {
  test.setTimeout(120_000);
  for (const era of ['modern', 'legacy'] as const) {
    const client = await connect(era);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['search', 'read', 'list_pages']));
      // Read-only by default: no write tool is listed.
      expect(tools).not.toContain('create_page');
      const result = (await client.callTool({ name: 'read', arguments: { id: 'Plan' } })) as { structuredContent?: { content?: string } };
      expect(result.structuredContent?.content).toContain('Ship the export.');
    } finally {
      await client.close();
    }
  }
});

test('takes no single-instance lock: the app window opens while it runs', async () => {
  test.setTimeout(120_000);
  const client = await connect('legacy');
  try {
    const app = await electron.launch({
      args: ['--ozone-platform=x11', appDir],
      env: { ...isolatedEnv(), GUMPLY_DESKTOP_VAULT: vault, GUMPLY_DESKTOP_PORT: String(Number(process.env.GUMPLY_DESKTOP_PORT ?? 11010) + 1) },
    });
    try {
      const window = await app.firstWindow({ timeout: 60_000 });
      await expect(window.getByTestId('page-tree')).toBeVisible({ timeout: 30_000 });
      // The app's window is its only one: the MCP process opened none.
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    } finally {
      await app.close().catch(() => undefined);
    }
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
});

test('exits 0 when stdin closes; 1 for a missing vault or MCP turned off; 2 without --vault', async () => {
  test.setTimeout(120_000);
  const closed = await runRaw(mcpArgs(), true);
  expect(closed.code).toBe(0);
  expect(closed.stdout).toBe('');

  expect((await runRaw([appDir, '--ozone-platform=x11', '--mcp', '--vault', join(scratch, 'nope')], true)).code).toBe(1);

  mkdirSync(join(vault, '.gumply'));
  writeFileSync(join(vault, '.gumply', 'mcp.json'), '{"enabled":false}');
  const off = await runRaw(mcpArgs(), true);
  expect(off.code).toBe(1);
  expect(off.stderr).toContain('MCP is turned off for this vault');

  expect((await runRaw([appDir, '--ozone-platform=x11', '--mcp'], true)).code).toBe(2);
});
