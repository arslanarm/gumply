import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';

/**
 * spec/auto-update §8 (#a7qepp99): an update from N to N+1, end to end, with
 * no GitHub release: CI packages a test build of N and of N+1
 * (GUMPLY_BUILD_TEST_FEED=1, so GUMPLY_UPDATE_FEED may point at 127.0.0.1)
 * and this serves N+1 from a local feed.
 *
 *   GUMPLY_UPDATE_OLD           N: the AppImage (Linux) or the NSIS installer (Windows)
 *   GUMPLY_UPDATE_OLD_VERSION   N's version
 *   GUMPLY_UPDATE_FEED_DIR      N+1's packaging output (installer, latest*.yml, blockmap)
 *   GUMPLY_UPDATE_NEW_VERSION   N+1's version
 *
 * Linux (AppImage): Off sends nothing; an older version and a tampered file
 * aren't installed; N+1 replaces the file at the same path at quit while an
 * AI app's --mcp from the old file keeps working; the next start is N+1.
 * Windows (NSIS per user): with an AI app's Gumply.exe --mcp running, neither
 * the app nor the installer's `--updated` run installs or kills it; once it's
 * gone, the next quit installs N+1.
 */
const oldApp = process.env.GUMPLY_UPDATE_OLD ? resolve(process.env.GUMPLY_UPDATE_OLD) : '';
const oldVersion = process.env.GUMPLY_UPDATE_OLD_VERSION ?? '';
const feedDir = process.env.GUMPLY_UPDATE_FEED_DIR ? resolve(process.env.GUMPLY_UPDATE_FEED_DIR) : '';
const newVersion = process.env.GUMPLY_UPDATE_NEW_VERSION ?? '';
const isLinux = process.platform === 'linux';
const isWindows = process.platform === 'win32';

test.skip(!oldApp || !feedDir || !oldVersion || !newVersion, 'Set GUMPLY_UPDATE_OLD/_OLD_VERSION/_FEED_DIR/_NEW_VERSION (CI builds them).');
test.skip(!isLinux && !isWindows, 'Updates install on Linux (AppImage) and Windows (NSIS) only.');
test.skip(
  isLinux && (process.env.GUMPLY_DESKTOP_HEADLESS !== '1' || !process.env.GUMPLY_TEST_DBUS),
  'Run via `npm run desktop:test` (virtual display + private D-Bus); refusing to touch the real desktop session.',
);
test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

function record(check: string, detail: string): void {
  console.log(`[update] ${check}: ${detail}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `| ${process.platform} | update: ${check} | ${detail.replace(/\|/g, '\\|')} |\n`);
}

const sha512 = (file: string) => createHash('sha512').update(readFileSync(file)).digest('base64');

// --- the feed ------------------------------------------------------------------

type FeedMode = 'real' | 'tampered' | 'old';
let feed: Server;
let feedUrl = '';
let feedMode: FeedMode = 'real';
let feedRequests: string[] = [];
const ymlName = isWindows ? 'latest.yml' : 'latest-linux.yml';

/** N+1's files; the yml as is, with a wrong sha512, or claiming N's version. */
function startFeed(): Promise<void> {
  feed = createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname.slice(1));
    feedRequests.push(name);
    const file = join(feedDir, basename(name));
    if (!name || name.includes('/') || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    if (name === ymlName) {
      let yml = readFileSync(file, 'utf8');
      if (feedMode === 'tampered') yml = yml.replace(/sha512: \S+/g, `sha512: ${Buffer.alloc(64, 7).toString('base64')}`);
      if (feedMode === 'old') yml = yml.replace(/^version: .*$/m, `version: ${oldVersion}`);
      response.writeHead(200, { 'content-type': 'text/yaml' }).end(yml);
      return;
    }
    response.writeHead(200, { 'content-length': statSync(file).size });
    response.end(readFileSync(file));
  });
  return new Promise((done) =>
    feed.listen(0, '127.0.0.1', () => {
      feedUrl = `http://127.0.0.1:${(feed.address() as AddressInfo).port}/`;
      done();
    }),
  );
}

// --- the app ------------------------------------------------------------------

let scratch = '';
let home = '';
let vault = '';
/** The installed app: the AppImage's own path, or the per-user Gumply.exe. */
let installed = '';
let app: ChildProcess | null = null;
let appLog = '';
let browser: Browser | null = null;
let page: Page;

const SESSION_VARS = new Set(['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'DESKTOP_SESSION', 'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP', 'SESSION_MANAGER']);

function appEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('XDG_') && !SESSION_VARS.has(key) && !key.startsWith('GUMPLY_')) env[key] = value;
  }
  if (process.env.GUMPLY_TEST_DBUS) env.DBUS_SESSION_BUS_ADDRESS = process.env.GUMPLY_TEST_DBUS;
  // Windows keeps its real folders: the per-user install and its uninstall entry live there.
  const dirs: Record<string, string> = isWindows
    ? {}
    : { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local', 'share') };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  return {
    ...env,
    ...dirs,
    GUMPLY_DESKTOP_VAULT: vault,
    GUMPLY_DESKTOP_USER_DATA: join(scratch, 'user-data'),
    GUMPLY_UPDATE_FEED: feedUrl,
    GUMPLY_UPDATE_FIRST_CHECK_MS: '500',
    ...extra,
  };
}

async function poll<T>(what: string, get: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const value = await Promise.resolve()
      .then(get)
      .catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`${what} within ${timeoutMs / 1000} s. App log:\n${appLog.slice(-3000)}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

/** Start the installed app with a debugging port on 127.0.0.1 and attach to its window. */
async function startApp(): Promise<void> {
  appLog = '';
  const portFile = join(scratch, 'user-data', 'DevToolsActivePort');
  // A previous launch's port file would point at a closed port.
  rmSync(portFile, { force: true });
  const args = ['--remote-debugging-port=0', ...(isLinux ? ['--ozone-platform=x11'] : [])];
  const child = spawn(installed, args, { env: appEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows });
  app = child;
  child.stdout!.on('data', (chunk: Buffer) => (appLog += chunk.toString()));
  child.stderr!.on('data', (chunk: Buffer) => (appLog += chunk.toString()));
  const host = await poll(
    'The debugging port',
    () => /DevTools listening on ws:\/\/([^/\s]+)\//.exec(appLog)?.[1] ?? (existsSync(portFile) ? `127.0.0.1:${readFileSync(portFile, 'utf8').split('\n')[0]}` : undefined),
    60_000,
  );
  browser = await chromium.connectOverCDP(`http://${host}`, { noDefaults: true, timeout: 60_000 });
  page = await poll('The window', () => browser!.contexts().flatMap((context) => context.pages()).find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url())), 60_000);
}

/** Quit the way a user does (close the window: save flush, then the update installs), and wait for the exit. */
async function quitApp(): Promise<void> {
  const child = app;
  if (!child) return;
  const exited = new Promise<void>((done) => (child.exitCode !== null ? done() : child.once('exit', () => done())));
  await page.evaluate(() => window.close()).catch(() => undefined);
  await browser?.close().catch(() => undefined);
  browser = null;
  await Promise.race([exited, new Promise((_, fail) => setTimeout(() => fail(new Error(`The app didn't quit. Log:\n${appLog.slice(-3000)}`)), 60_000))]);
  app = null;
}

function killApp(): void {
  const child = app;
  app = null;
  if (!child?.pid || child.exitCode !== null) return;
  if (isWindows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGKILL');
}

async function health(): Promise<{ version?: string }> {
  return (await (await fetch(new URL('/api/health', page.url()))).json()) as { version?: string };
}

/** Settings → Updates → Check now; returns the status line once `done` matches it. */
async function checkNow(done: RegExp, timeoutMs = 120_000): Promise<string> {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-updates').click();
  await page.getByTestId('updates-check').click();
  const status = page.getByTestId('updates-status');
  await expect(status).toHaveText(done, { timeout: timeoutMs });
  const text = (await status.textContent()) ?? '';
  await page.getByTestId('updates-close').click();
  return text;
}

/** An AI app's server, started exactly as the Claude Desktop snippet starts it. */
async function startMcp(): Promise<Client> {
  const args = [...(isLinux ? ['--mcp', '--ozone-platform=headless'] : ['--mcp']), '--vault', vault];
  const env: Record<string, string> = { ...getDefaultEnvironment(), ...(isWindows ? {} : { HOME: home }) };
  const client = new Client({ name: 'update-test-ai-app', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: installed, args, env, stderr: 'pipe' }));
  return client;
}

/** Windows: the per-user install's uninstall entry version. */
function installedVersion(): string {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', "(Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' | Get-ItemProperty | Where-Object DisplayName -like 'Gumply*' | Select-Object -First 1).DisplayVersion"],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return result.stdout.trim();
}

function writeMode(mode: 'auto' | 'notify' | 'off'): void {
  const dir = join(scratch, 'user-data');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'gumply-desktop.json'), JSON.stringify({ lastVault: null, recentVaults: [], window: null, uiState: {}, updates: { mode } }));
}

test.beforeAll(async () => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'gumply-update-')));
  home = join(scratch, 'home');
  vault = join(scratch, 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'Plan.md'), '# Plan\n\nShip the update.\n');
  await startFeed();
  if (isLinux) {
    // A versioned name, as downloaded: the update must keep exactly this path.
    const apps = join(scratch, 'Apps');
    mkdirSync(apps);
    installed = join(apps, basename(oldApp));
    copyFileSync(oldApp, installed);
    chmodSync(installed, 0o755);
  } else {
    const result = spawnSync(oldApp, ['/S'], { stdio: 'ignore', timeout: 180_000 });
    expect(result.status, 'N installs').toBe(0);
    installed = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Gumply', 'Gumply.exe');
    expect(existsSync(installed), installed).toBe(true);
    expect(installedVersion()).toBe(oldVersion);
  }
  record('installed N', `${oldVersion} at ${installed}; feed ${feedUrl} serving ${readdirSync(feedDir).filter((n) => !n.endsWith('-unpacked')).join(', ')}`);
});

test.afterEach(() => killApp());

test.afterAll(async () => {
  killApp();
  await new Promise((done) => feed?.close(done));
  rmSync(scratch, { recursive: true, force: true });
});

test('Off: no request to the feed at all', async () => {
  writeMode('off');
  feedRequests = [];
  await startApp();
  await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 30_000 });
  // The first automatic check would have run at 0.5 s.
  await page.waitForTimeout(5_000);
  expect(feedRequests).toEqual([]);
  await quitApp();
  record('off', '0 requests in 5 s');
});

test('a feed offering N itself: nothing to install', async () => {
  writeMode('auto');
  feedMode = 'old';
  await startApp();
  expect(await checkNow(/is up to date/)).toContain(oldVersion);
  await quitApp();
  record('same version', 'up to date');
});

test('a file that fails its sha512: never installed, N untouched', async () => {
  feedMode = 'tampered';
  const before = sha512(installed);
  await startApp();
  feedRequests = [];
  await checkNow(/is available|Couldn't/);
  await page.waitForTimeout(3_000);
  // It did download N+1 (so the refusal is the sha512 check, not a missing file).
  expect(feedRequests.some((name) => /\.(AppImage|exe)$/.test(name))).toBe(true);
  await expect(page.getByTestId('update-notice')).not.toHaveAttribute('data-status', 'ready');
  await quitApp();
  expect(sha512(installed)).toBe(before);
  if (isWindows) expect(installedVersion()).toBe(oldVersion);
  record('tampered', `downloaded (${feedRequests.filter((name) => /\.(AppImage|exe)$/.test(name)).length} request(s)), refused, N unchanged`);
});

if (isLinux) {
  test('AppImage: N+1 at quit, at the same path, while an AI app on the old file keeps working; the next start is N+1', async () => {
    feedMode = 'real';
    const mcp = await startMcp();
    try {
      await startApp();
      expect((await health()).version).toBe(oldVersion);
      await checkNow(/is ready/);
      await quitApp();

      const newFile = readdirSync(feedDir).find((name) => name.endsWith('.AppImage'))!;
      expect(sha512(installed)).toBe(sha512(join(feedDir, newFile)));
      expect(statSync(installed).mode & 0o777).toBe(0o755);
      expect(readdirSync(dirname(installed))).toEqual([basename(installed)]);
      // The old file's mount is still there for the running AI app's server.
      expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);

      await startApp();
      expect((await health()).version).toBe(newVersion);
      await quitApp();
      record('AppImage N→N+1', `${oldVersion} → ${newVersion} at ${installed}; the --mcp from the old file kept answering`);
    } finally {
      await mcp.close().catch(() => undefined);
    }
  });
}

if (isWindows) {
  test("Windows: an AI app's Gumply.exe --mcp is never killed, and the update waits for it", async () => {
    feedMode = 'real';
    const mcp = await startMcp();
    try {
      // The installer's own --updated run (layer 2): with --mcp still running it quits, installing nothing.
      const installer = readdirSync(feedDir).find((name) => /^Gumply-Setup-.*\.exe$/.test(name))!;
      const hook = spawnSync(join(feedDir, installer), ['/S', '--updated'], { stdio: 'ignore', timeout: 120_000 });
      expect(installedVersion()).toBe(oldVersion);
      expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);
      record('NSIS hook', `installer --updated exited ${hook.status} without installing; --mcp untouched`);

      // The app (layer 1): ready, but at quit it sees --mcp and leaves the update pending.
      await startApp();
      await checkNow(/is ready/);
      await quitApp();
      await new Promise((done) => setTimeout(done, 15_000));
      expect(installedVersion()).toBe(oldVersion);
      expect((await mcp.listTools()).tools.length).toBeGreaterThan(0);
      record('pending', 'not installed at quit while --mcp ran; --mcp untouched');
    } finally {
      await mcp.close().catch(() => undefined);
    }
  });

  test('Windows: once nothing else runs, the next quit installs N+1', async () => {
    await new Promise((done) => setTimeout(done, 3_000));
    await startApp();
    expect((await health()).version).toBe(oldVersion);
    await checkNow(/is ready/);
    await quitApp();
    await poll('N+1 installed', () => (installedVersion() === newVersion ? true : undefined), 180_000);
    await startApp();
    expect((await health()).version).toBe(newVersion);
    await quitApp();
    record('NSIS N→N+1', `${oldVersion} → ${newVersion}`);
  });
}
