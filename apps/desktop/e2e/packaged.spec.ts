import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { expectPageTitle } from '../../../e2e/support/ui';
import { claudeDesktopConfigPath } from '../../web/src/lib/mcp-snippets.js';

/**
 * #429bvzwr: the **installed** app on each OS, as a user gets it (CI installs
 * it first: NSIS per user on Windows, the arm64 .dmg copied to ~/Applications
 * on macOS, the AppImage itself on Linux). The gate's Windows/macOS owner rows,
 * done by CI:
 * - it starts on the vault and reports the release version;
 * - Help → Open-Source Licences' file is in the installed app's resources;
 * - File → Export as PDF… prints through this OS's print backend;
 * - the Claude Desktop snippet from Settings → AI apps, written into
 *   `claude_desktop_config.json` and started the way Claude Desktop starts it,
 *   serves the vault over MCP while the app is open.
 *
 * Shipped builds have the `EnableNodeCliInspectArguments` fuse off, so
 * Playwright's `_electron` can't reach their main process. The window is
 * driven over CDP (`--remote-debugging-port`, a Chromium switch), and menu
 * items are reached through what they do (the PDF item's `gumply:command`
 * event) or what they open (the notices file). The menu clicks themselves are
 * covered by the development specs (desktop.spec, pdf.spec).
 *
 *   GUMPLY_PACKAGED_APP=<Gumply.exe | …/Gumply.app/Contents/MacOS/Gumply | Gumply-…AppImage>
 *   GUMPLY_PACKAGED_VERSION=<the version it must report>   (optional)
 *   node apps/desktop/scripts/test.mjs packaged.spec.ts
 */
const packaged = process.env.GUMPLY_PACKAGED_APP ? resolve(process.env.GUMPLY_PACKAGED_APP) : '';
const expectedVersion = process.env.GUMPLY_PACKAGED_VERSION ?? '';
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';
const isAppImage = isLinux && packaged.endsWith('.AppImage');

test.skip(!packaged, 'Set GUMPLY_PACKAGED_APP to an installed Gumply to run these.');
test.skip(
  isLinux && (process.env.GUMPLY_DESKTOP_HEADLESS !== '1' || !process.env.GUMPLY_TEST_DBUS),
  'Run via `npm run desktop:test` (virtual display + private D-Bus); refusing to touch the real desktop session.',
);
test.describe.configure({ mode: 'serial' });

/**
 * Both ports are random free ones on 127.0.0.1: the app's server (no
 * GUMPLY_DESKTOP_PORT) and Chromium's debugging port (`=0`; Chromium only
 * listens on loopback). They're read back once the app is up.
 */
let cdpUrl = '';
let appOrigin = '';

/** One row of the CI job summary (and the log). */
function record(check: string, detail: string): void {
  const line = `| ${process.platform} | ${check} | ${detail.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`;
  console.log(`[packaged] ${check}: ${detail}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `${line}\n`);
}

/** A real 40×30 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACgAAAAeCAIAAADRv8uKAAAAN0lEQVR4nGPQmts/IIhh1OLRoB5NXKPZabQAGS0yRyuJ0WpxtAUy2uYabWWOtqtHexJag7bvBAC2mEN7vU6FZQAAAABJRU5ErkJggg==',
  'base64',
);
const rows = Array.from({ length: 120 }, (_, index) => `| ${index + 1} | Row ${index + 1} | ${'note '.repeat(6).trim()} |`).join('\n');
const REPORT = ['## Summary', '', '![[chart.png]]', '', 'Energy: $E = mc^2$.', '', '| # | Name | Notes |', '| --- | --- | --- |', rows, ''].join('\n');

let scratch = '';
let home = '';
/** A space and Cyrillic in the path: JSON escaping and Windows quoting both get exercised. */
let vault = '';
let downloads = '';
let app: ChildProcess | null = null;
let appLog = '';
let browser: Browser | null = null;
let page: Page;

const SESSION_VARS = new Set(['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'DESKTOP_SESSION', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'SESSION_MANAGER']);

/** The user's folders, all inside the scratch dir (P11; a CI runner is thrown away anyway). */
function userDirs(): Record<string, string> {
  const dirs: Record<string, string> = isWindows
    ? {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
      }
    : {
        HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
        XDG_DATA_HOME: join(home, '.local', 'share'),
        XDG_CACHE_HOME: join(home, '.cache'),
        XDG_STATE_HOME: join(home, '.local', 'state'),
      };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return dirs;
}

function appEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('XDG_') && !SESSION_VARS.has(key) && !key.startsWith('GUMPLY_')) env[key] = value;
  }
  if (process.env.GUMPLY_TEST_DBUS) env.DBUS_SESSION_BUS_ADDRESS = process.env.GUMPLY_TEST_DBUS;
  return {
    ...env,
    ...userDirs(),
    GUMPLY_DESKTOP_VAULT: vault,
    GUMPLY_DESKTOP_USER_DATA: join(scratch, 'user-data'),
    GUMPLY_DESKTOP_DOWNLOAD_DIR: downloads,
  };
}

async function poll<T>(what: string, get: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await get().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`${what} within ${timeoutMs / 1000} s. App log:\n${appLog.slice(-4000)}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Stop the app and everything it started, by its PID (its process group on Linux/macOS). */
async function stopApp(): Promise<void> {
  const child = app;
  app = null;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (!isWindows && child.exitCode === null) process.kill(-child.pid!, 'SIGKILL');
  }, 15_000);
  await exited;
  clearTimeout(timer);
}

/** The running app's process and its descendants (Linux), parent first. */
function processTree(root: number): number[] {
  const parents = new Map<number, number[]>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      parents.set(ppid, [...(parents.get(ppid) ?? []), Number(name)]);
    } catch {
      // Gone meanwhile.
    }
  }
  const tree = [root];
  for (let index = 0; index < tree.length; index++) tree.push(...(parents.get(tree[index]!) ?? []));
  return tree;
}

/**
 * Where the installed app keeps its resources. For the AppImage, its mount:
 * AppRun runs `$APPDIR/gumply`, so that's the app process's argv[0]
 * (/proc/<pid>/environ isn't readable: Chromium makes its processes non-dumpable).
 */
function resourcesDir(): string {
  if (process.platform === 'darwin') return join(dirname(packaged), '..', 'Resources');
  if (!isAppImage) return join(dirname(packaged), 'resources');
  for (const pid of processTree(app!.pid!)) {
    try {
      // Chromium rewrites its command line as one space-separated title; the mount path has no spaces.
      const argv0 = (readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0] ?? '').split(' ')[0] ?? '';
      if (argv0.endsWith('/gumply') && existsSync(join(dirname(argv0), 'resources'))) return join(dirname(argv0), 'resources');
    } catch {
      // Gone meanwhile.
    }
  }
  const seen = processTree(app!.pid!).map((pid) => {
    try {
      return `${pid}: ${readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').slice(0, 2).join(' ')}`;
    } catch {
      return `${pid}: ?`;
    }
  });
  throw new Error(`The AppImage's mount (\`$APPDIR/gumply\`) wasn't found among its processes:\n${seen.join('\n')}`);
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gumply-packaged-')));
  home = join(scratch, 'home');
  vault = join(scratch, 'Gumply Тест', 'vault');
  downloads = join(scratch, 'downloads');
  for (const dir of [vault, downloads]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(vault, 'Plan.md'), '# Plan\n\nShip the export.\n');
  writeFileSync(join(vault, 'Report.md'), REPORT);
  writeFileSync(join(vault, 'chart.png'), PNG);

  // macOS: Chromium's mock keychain, so cookie encryption (a fuse) never waits
  // on a Keychain prompt on the runner, which would hold the main thread.
  const args = ['--remote-debugging-port=0', ...(isLinux ? ['--ozone-platform=x11'] : []), ...(process.platform === 'darwin' ? ['--use-mock-keychain'] : [])];
  const child = spawn(packaged, args, { env: appEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows });
  app = child;
  child.stdout!.on('data', (chunk: Buffer) => (appLog += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (appLog += chunk.toString()));
  // The port Chromium picked: its "DevTools listening on ws://host:port/…" line,
  // or the DevToolsActivePort file in the user-data folder (a GUI-subsystem
  // Windows app may not write to the pipe).
  const activePortFile = join(scratch, 'user-data', 'DevToolsActivePort');
  const host = await poll(
    "The app's debugging port wasn't announced",
    async () => {
      const announced = /DevTools listening on ws:\/\/([^/\s]+)\//.exec(appLog)?.[1];
      if (announced) return announced;
      const port = existsSync(activePortFile) ? Number(readFileSync(activePortFile, 'utf8').split('\n')[0]) : 0;
      return port > 0 ? `127.0.0.1:${port}` : undefined;
    },
    60_000,
  );
  expect(host, 'the debugging port listens on loopback only').toMatch(/^127\.0\.0\.1:\d+$/);
  cdpUrl = `http://${host}`;
  await poll("The app's debugging port didn't answer", async () => ((await fetch(`${cdpUrl}/json/version`)).ok ? true : undefined), 30_000);
  // The window exists before anything attaches (plain HTTP, answered off the main thread).
  await poll(
    "The app's window didn't appear among its debugging targets",
    async () => ((await targets()).some((target) => target.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(target.url)) ? true : undefined),
    60_000,
  );
  // noDefaults: Playwright leaves the app's own settings alone; without it, it
  // takes over downloads, and the PDF export (a download main prints) never arrives.
  try {
    browser = await chromium.connectOverCDP(cdpUrl, { noDefaults: true, timeout: 60_000 });
  } catch (error) {
    const list = await targets().catch(() => []);
    throw new Error(`connectOverCDP failed. Targets: ${JSON.stringify(list)}\nApp log:\n${appLog.slice(-4000)}`, { cause: error });
  }
  page = await poll(
    "The app's window didn't open",
    async () => browser!.contexts().flatMap((context) => context.pages()).find((candidate) => /^http:\/\/127\.0\.0\.1:\d+\//.test(candidate.url())),
    60_000,
  );
  appOrigin = new URL(page.url()).origin;
});

/** The app's debugging targets (`/json/list`). */
async function targets(): Promise<Array<{ type: string; url: string; title: string }>> {
  return (await (await fetch(`${cdpUrl}/json/list`, { signal: AbortSignal.timeout(5_000) })).json()) as Array<{ type: string; url: string; title: string }>;
}

/** Where failures leave their logs (uploaded by CI). */
const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-results', 'desktop');

function keepLog(name: string, text: string): void {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(join(resultsDir, name), text);
}

/** Whether anything still answers at `url`. */
async function answers(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false,
  );
}

test.afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await stopApp();
  if (appLog) keepLog('packaged-app.log', appLog);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  // Closed for real: neither port answers any more.
  const ports = [cdpUrl && `${cdpUrl}/json/version`, appOrigin && `${appOrigin}/api/health`].filter(Boolean);
  for (const url of ports) await expect.poll(() => answers(url), { timeout: 15_000, message: `${url} still answers after the app was closed` }).toBe(false);
  if (ports.length) record('app closed, ports freed', ports.map((url) => new URL(url).host).join(', '));
});

test('starts on the vault and reports the release version', async () => {
  const health = (await (await fetch(`${appOrigin}/api/health`)).json()) as { version?: string; desktop?: boolean };
  expect(health.desktop).toBe(true);
  if (expectedVersion) expect(health.version).toBe(expectedVersion);
  await expect(page.getByTestId('page-item-Plan')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('page-item-Plan').click();
  await expectPageTitle(page, 'Plan');
  record('starts, opens the vault', `version ${health.version} from ${packaged}`);
});

test("Help → Open-Source Licences' file is in the installed app's resources", async () => {
  const notices = join(resourcesDir(), 'THIRD_PARTY_NOTICES.txt');
  expect(existsSync(notices), notices).toBe(true);
  const text = readFileSync(notices, 'utf8');
  expect(text).toContain('# Third-party notices');
  record('licences file installed', `${notices} (${text.length} chars)`);
});

test('File → Export as PDF… prints a multi-page PDF through the OS print backend', async () => {
  test.setTimeout(120_000);
  await page.getByTestId('page-item-Report').click();
  await expect(page.getByTestId('editor-content')).toContainText('Summary');
  // What the menu item does (main.ts sendCommand).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('gumply:command', { detail: 'export-pdf' })));
  await expect(page.getByTestId('export-dialog')).toContainText('Export as PDF');
  await page.getByTestId('export-size-A4').check();
  await page.getByTestId('export-confirm').click();

  const pdfPath = join(downloads, 'Report.pdf');
  await expect.poll(() => existsSync(pdfPath), { timeout: 60_000 }).toBe(true);
  await expect.poll(() => readFileSync(pdfPath).length, { timeout: 10_000 }).toBeGreaterThan(1000);
  const pdf = readFileSync(pdfPath);
  expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  expect(pages).toBeGreaterThan(1);
  record('PDF export', `${pages} pages, ${pdf.length} bytes`);
});

test('the Claude Desktop snippet, written into claude_desktop_config.json, serves the vault while the app is open', async () => {
  test.setTimeout(120_000);
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-mcp').click();
  const snippetText = await page.getByTestId('mcp-snippet-claude-desktop').innerText();
  const snippet = JSON.parse(snippetText) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const [[name, entry]] = Object.entries(snippet.mcpServers) as [[string, { command: string; args: string[] }]];

  // The installed app itself: not a temp, disk-image or translocated copy.
  const same = (a: string, b: string) => (isWindows ? a.toLowerCase() === b.toLowerCase() : a === b);
  expect(same(resolve(entry.command), packaged), `${entry.command} vs ${packaged}`).toBe(true);
  const flags = isLinux ? ['--mcp', '--ozone-platform=headless'] : ['--mcp'];
  expect(entry.args.slice(0, -1)).toEqual([...flags, '--vault']);
  expect(realpathSync(entry.args.at(-1)!)).toBe(realpathSync(vault));
  expect(entry.args).not.toContain('--no-sandbox');
  // No "move it to Applications" or npm hint; on Linux, the AppImage one.
  const hints = await page.getByTestId('mcp-hint').allInnerTexts();
  expect(hints.length).toBe(isAppImage ? 1 : 0);
  await expect(page.getByTestId('mcp-settings')).toContainText(claudeDesktopConfigPath(process.platform));
  record('Claude Desktop snippet', snippetText.replace(/\s+/g, ' '));

  // Claude Desktop's own config file, at its real place, with another server already in it.
  const dirs = userDirs();
  const configFile =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : isWindows
        ? join(dirs.APPDATA!, 'Claude', 'claude_desktop_config.json')
        : join(home, '.config', 'Claude', 'claude_desktop_config.json');
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify({ mcpServers: { other: { command: 'other-server', args: [] } } }, null, 2));
  const existing = JSON.parse(readFileSync(configFile, 'utf8')) as { mcpServers: Record<string, unknown> };
  writeFileSync(configFile, JSON.stringify({ ...existing, mcpServers: { ...existing.mcpServers, ...snippet.mcpServers } }, null, 2));
  const config = JSON.parse(readFileSync(configFile, 'utf8')) as typeof snippet;
  expect(Object.keys(config.mcpServers).sort()).toEqual([name, 'other'].sort());
  const server = config.mcpServers[name]!;

  // Started as Claude Desktop starts a server: command and args, no shell, and no display.
  // The MCP SDK's inherited variables (as a client like Claude Desktop passes on), with this test's user folders.
  const serverEnv: Record<string, string> = { ...getDefaultEnvironment(), ...dirs };
  // One raw exchange first, so a failure says which side is silent: the
  // server's stderr shows whether it started, stdout whether it answered.
  const probe = await new Promise<{ stdout: string; stderr: string; code: number | null }>((done) => {
    const child = spawn(server.command, server.args, { env: serverEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const finish = () => {
      clearTimeout(timer);
      child.stdin!.end();
      done({ stdout, stderr, code: child.exitCode });
    };
    const timer = setTimeout(finish, 30_000);
    child.stdout!.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Not the first newline: Electron on Windows writes a blank line at startup.
      if (stdout.includes('"serverInfo"') && stdout.trimEnd().endsWith('}')) finish();
    });
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin!.on('error', () => undefined);
    child.once('exit', finish);
    const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } };
    child.stdin!.write(`${JSON.stringify(initialize)}\n`);
  });
  keepLog('packaged-mcp-probe.log', `stdout (JSON):\n${JSON.stringify(probe.stdout)}\n\nstderr (JSON):\n${JSON.stringify(probe.stderr)}\n\nexit: ${probe.code}`);
  // JSON-quoted, so a stray \n or \r\n before the answer shows.
  record('MCP raw initialize', `stdout ${JSON.stringify(probe.stdout.slice(0, 200))}; stderr ${JSON.stringify(probe.stderr.slice(0, 200))}; exit ${probe.code ?? 'still running'}`);
  expect(probe.stdout, `no answer on stdout; stderr: ${probe.stderr}`).toContain('"serverInfo"');

  const client = new Client({ name: 'claude-desktop-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env: serverEnv, stderr: 'pipe' });
  let serverStderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => (serverStderr += chunk.toString()));
  await client.connect(transport).catch((error: unknown) => {
    throw new Error(`MCP connect failed; server stderr:\n${serverStderr}`, { cause: error });
  });
  try {
    const info = client.getServerVersion();
    expect(info?.name).toBe('gumply');
    if (expectedVersion) expect(info?.version).toBe(expectedVersion);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(['search', 'read', 'list_pages']));
    expect(tools).not.toContain('create_page');
    const result = (await client.callTool({ name: 'read', arguments: { id: 'Plan' } })) as { structuredContent?: { content?: string } };
    expect(result.structuredContent?.content).toContain('Ship the export.');
    record('MCP from the config', `serverInfo ${info?.name} ${info?.version}; ${tools.length} tools; read Plan ok; app window open`);
  } finally {
    await client.close();
  }

  // Closing stdin ends it with 0, as when Claude Desktop quits.
  const code = await new Promise<number | null>((done, fail) => {
    const child = spawn(server.command, server.args, { env: serverEnv, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error('--mcp did not exit within 30 s of its stdin closing'));
    }, 30_000);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
    setTimeout(() => child.stdin!.end(), 1_500);
  });
  expect(code).toBe(0);
  record('MCP exit on stdin close', `code ${code}`);
});
