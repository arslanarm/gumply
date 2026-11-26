import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { _electron as electron, expect, test } from '@playwright/test';
import { mcpLaunchCommand, userNamespacesWork } from '../src/mcp-mode.js';

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

/**
 * #4ckqijua: every MCP spawn starts exactly as Settings → AI apps prints the
 * development command, including its user-namespace probe. Development Electron
 * has no AppArmor profile, so where Ubuntu 23.10+ restricts user namespaces the
 * command carries --no-sandbox, as AppRun decides for the AppImage; elsewhere it
 * doesn't. No test-only flags.
 */
const launch = mcpLaunchCommand({
  execPath: electronPath,
  packaged: false,
  appPath: appDir,
  platform: process.platform,
  userNamespaces: userNamespacesWork(existsSync, (command, args) => spawnSync(command, args, { stdio: 'ignore', timeout: 2000 }).status),
});
/** The launch args without the app folder (it comes first). */
const flags = launch.args.slice(1);
const mcpArgs = (extra: string[] = []) => [...launch.args, '--vault', vault, ...extra];

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

test('A4: `gumply mcp --vault …` (the npm form; /usr/bin/gumply from a .deb) is MCP mode, never a window', async () => {
  test.setTimeout(60_000);
  // In development `mcp` follows the app folder, as `/opt/Gumply/gumply mcp` has it first.
  const transport = new StdioClientTransport({
    command: electronPath,
    args: [appDir, 'mcp', ...flags.filter((flag) => flag !== '--mcp'), '--vault', vault],
    env: isolatedEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'desktop-npm-form', version: '1.0.0' });
  await client.connect(transport);
  try {
    const result = (await client.callTool({ name: 'read', arguments: { id: 'Plan' } })) as { structuredContent?: { content?: string } };
    expect(result.structuredContent?.content).toContain('Ship the export.');
  } finally {
    await client.close();
  }
});

test('A4: the Linux snippet starts with no display at all (no DISPLAY, no WAYLAND_DISPLAY), as over SSH', async () => {
  test.skip(process.platform !== 'linux', 'Linux snippet');
  test.setTimeout(60_000);
  // Exactly the args Settings → AI apps prints in development (the packaged ones are pinned in the unit test).
  const { command, args } = launch;
  const env = isolatedEnv();
  delete env.DISPLAY;
  delete env.WAYLAND_DISPLAY;
  env.XDG_SESSION_TYPE = 'wayland'; // a stale session variable: Chromium would pick Wayland and exit
  const transport = new StdioClientTransport({ command, args: [...args, '--vault', vault], env, stderr: 'pipe' });
  const client = new Client({ name: 'desktop-headless', version: '1.0.0' });
  await client.connect(transport);
  try {
    // #6bxm6ygf: the app's own version (app.getVersion(), stamped from the release tag), not CORE_VERSION.
    const appVersion = (JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string }).version;
    expect(client.getServerVersion()).toMatchObject({ name: 'gumply', version: appVersion });
    const result = (await client.callTool({ name: 'read', arguments: { id: 'Plan' } })) as { structuredContent?: { content?: string } };
    expect(result.structuredContent?.content).toContain('Ship the export.');
  } finally {
    await client.close();
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

test('writes nothing to the app\'s settings: no recent vaults, no window state', async () => {
  test.setTimeout(120_000);
  const userData = join(scratch, 'user-data');
  mkdirSync(userData, { recursive: true });
  const before = JSON.stringify({ lastVault: join(scratch, 'other'), recentVaults: [join(scratch, 'other')], window: { width: 900, height: 700 } });
  writeFileSync(join(userData, 'gumply-desktop.json'), before);
  const listing = () => readdirSync(userData, { recursive: true }).map(String).sort();
  const filesBefore = listing();

  const client = await connect('legacy');
  try {
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
  } finally {
    await client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(readFileSync(join(userData, 'gumply-desktop.json'), 'utf8')).toBe(before);
  console.log(`[mcp userData] ${listing().join(', ')}`);
  expect(listing()).toEqual(filesBefore);
});

test('#vduteee7: a rename it journals is the app\'s installation\'s (its id in the app\'s own userData), so the app finishes one it leaves half done', async () => {
  test.setTimeout(120_000);
  const userData = join(scratch, 'user-data');
  mkdirSync(join(vault, '.gumply'), { recursive: true });
  writeFileSync(join(vault, '.gumply', 'mcp.json'), JSON.stringify({ enabled: true, access: 'edit' }));
  writeFileSync(join(vault, 'Linker.md'), 'See [[Plan]].\n');
  expect(existsSync(join(userData, 'instance-id'))).toBe(false);

  const transport = new StdioClientTransport({ command: electronPath, args: mcpArgs(), env: isolatedEnv(), stderr: 'pipe' });
  const client = new Client({ name: 'desktop-rename', version: '1.0.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await client.connect(transport);
  try {
    const read = (await client.callTool({ name: 'read', arguments: { id: 'Plan' } })) as { structuredContent?: { updated?: string } };
    const renamed = (await client.callTool({
      name: 'update_page',
      arguments: { id: 'Plan', expectedUpdated: read.structuredContent?.updated, title: 'Plan renamed' },
    })) as { isError?: boolean };
    expect(renamed.isError).toBeFalsy();
  } finally {
    await client.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  // The id the rename was journalled under is the app's own (not one in --mcp's throwaway folder, gone at exit).
  expect(existsSync(join(userData, 'instance-id'))).toBe(true);
  expect(readFileSync(join(vault, 'Linker.md'), 'utf8')).toContain('[[Plan renamed]]');
});

test('exits 0 when stdin closes; 1 for a missing vault or MCP turned off; 2 without --vault', async () => {
  test.setTimeout(120_000);
  const closed = await runRaw(mcpArgs(), true);
  expect(closed.code).toBe(0);
  expect(closed.stdout).toBe('');

  expect((await runRaw([...launch.args, '--vault', join(scratch, 'nope')], true)).code).toBe(1);

  mkdirSync(join(vault, '.gumply'));
  writeFileSync(join(vault, '.gumply', 'mcp.json'), '{"enabled":false}');
  const off = await runRaw(mcpArgs(), true);
  expect(off.code).toBe(1);
  expect(off.stderr).toContain('MCP is turned off for this vault');

  expect((await runRaw([...launch.args], true)).code).toBe(2);
});
