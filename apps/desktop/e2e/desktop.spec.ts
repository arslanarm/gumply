import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { expectPageTitle } from '../../../e2e/support/ui';

/**
 * D26 smoke: the packaged-style app (dist/main.mjs + dist/web) with a temp
 * vault and a temp settings dir. Build first: `npm run build -w @gumply/desktop`.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.GUMPLY_DESKTOP_PORT ?? 11010);
const shots = process.env.GUMPLY_DESKTOP_SHOTS;

// Linux: only on the virtual display set up by `npm run desktop:test`
// (xvfb-run). Run directly, X11 would draw on the user's real desktop.
test.skip(
  process.platform === 'linux' && (process.env.GUMPLY_DESKTOP_HEADLESS !== '1' || !process.env.GUMPLY_TEST_DBUS),
  'Run via `npm run desktop:test` (virtual display + private D-Bus); refusing to touch the real desktop session.',
);

let scratch: string;
let vault: string;
let userData: string;

test.beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gumply-desktop-'));
  vault = join(scratch, 'vault');
  userData = join(scratch, 'user-data');
});
test.afterEach(() => {
  // A test that failed or timed out never leaves its app running (#qq2snvfh):
  // stop exactly the Electron processes this file started.
  for (const child of launched.values()) stopProcess(child);
  launched.clear();
  rmSync(scratch, { recursive: true, force: true });
});

/** Every app `launch` started, with its own child process (taken while it runs). */
const launched = new Map<ElectronApplication, ChildProcess>();

function stopProcess(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

/**
 * Quit the app (or close its window) and wait for it to exit (#qq2snvfh).
 * A loaded machine gets a full minute; if it still doesn't exit, it is
 * stopped before the error is reported.
 */
async function quitAndWait(app: ElectronApplication, how: 'quit' | 'close-window'): Promise<void> {
  const closed = app.waitForEvent('close', { timeout: 60_000 });
  if (how === 'quit') await app.evaluate(({ app: electronApp }) => electronApp.quit());
  else await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  try {
    await closed;
  } catch (error) {
    // Say why it didn't quit (#8zc7xkgq): the save flush didn't finish and
    // the "couldn't be saved" dialog is waiting (invisible under xvfb).
    const dialog = await app
      .evaluate(() => (globalThis as { __gumplyUnsavedDialog?: { open: boolean; reason: string | null } }).__gumplyUnsavedDialog ?? null)
      .catch(() => null);
    const child = launched.get(app);
    if (child) stopProcess(child);
    const verb = how === 'quit' ? 'quit' : 'close';
    if (dialog?.open) {
      throw new Error(
        `The app didn't ${verb}: the save flush didn't finish, and the "couldn't be saved" dialog is shown. ` +
          `Why (#ms44vnit): ${dialog.reason ?? 'unknown'}.`,
      );
    }
    // The dialog came and was answered "Cancel": still say why it came.
    if (dialog?.reason) throw new Error(`The app didn't ${verb}: the save flush wasn't complete (${dialog.reason}), so it asked first.`);
    throw error;
  } finally {
    launched.delete(app);
  }
}

/** Variables that would let the app reach the user's real session or files. */
// Every XDG_* variable is dropped (and the dirs replaced below), plus these.
const SESSION_VARS = new Set([
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'KDE_FULL_SESSION',
  'KDE_SESSION_VERSION',
  'GNOME_DESKTOP_SESSION_ID',
  'GDK_BACKEND',
  'QT_QPA_PLATFORM',
  'SESSION_MANAGER',
]);

/**
 * Team rule (platform-issues P11): X11 on the virtual display only, a private
 * D-Bus that can't start any service, and a scratch HOME/XDG_* per launch, so
 * nothing (a file manager, a portal, a keyring) can touch the user's session.
 */
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
  return { ...base, ...dirs };
}

/** What the app does after each launch phase (#tcw8r7vc): names the slow step when the window is late. */
const NEXT_STEP: Record<string, string> = {
  start: 'Electron starting and loading the app bundle (dist/main.mjs, with the server)',
  'main-loaded': "Electron's app ready",
  'app-ready': 'opening the vault',
  'server-starting': 'the in-process server starting (vault index, demo seed)',
  'server-started': 'creating the window',
  'window-created': 'Playwright seeing the window',
};

/** How long the first window may take; a cold first launch on a loaded machine is the slow one. */
const FIRST_WINDOW_MS = Number(process.env.GUMPLY_DESKTOP_FIRST_WINDOW_MS ?? 45_000);

/** The app's launch phases (ms since its process started), or [] if it doesn't answer. */
async function launchPhases(app: ElectronApplication): Promise<Array<[string, number]>> {
  const phases = app
    .evaluate(() => (globalThis as { __gumplyLaunchPhases?: Array<[string, number]> }).__gumplyLaunchPhases ?? [])
    .catch(() => []);
  return Promise.race([phases, new Promise<Array<[string, number]>>((resolve) => setTimeout(() => resolve([]), 5_000))]);
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> {
  const base = isolatedEnv();
  const started = Date.now();
  const app = await electron.launch({
    args: ['--ozone-platform=x11', appDir],
    env: {
      ...base,
      GUMPLY_DESKTOP_USER_DATA: userData,
      GUMPLY_DESKTOP_PORT: String(port),
      ...env,
    },
  });
  launched.set(app, app.process());
  const connected = Date.now() - started;
  try {
    const window = await app.firstWindow({ timeout: Math.max(1, FIRST_WINDOW_MS - connected) });
    const phases = await launchPhases(app);
    console.log(
      `[desktop launch] Playwright connected ${seconds(connected)}; app: ${phases.map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(', ')}; window seen ${seconds(Date.now() - started)}`,
    );
    return { app, window };
  } catch (error) {
    const phases: Array<[string, number]> = [['start', 0], ...(await launchPhases(app))];
    const [last, lastAt] = phases[phases.length - 1]!;
    const steps = phases.slice(1).map(([phase, ms], index) => [phase, ms - phases[index]![1]] as const);
    const slowest = steps.reduce<readonly [string, number]>((worst, step) => (step[1] > worst[1] ? step : worst), ['', -1]);
    const elapsed = Date.now() - started;
    throw new Error(
      `The app's first window didn't open within ${seconds(FIRST_WINDOW_MS)}: stuck after "${last}" (at ${seconds(lastAt)}), ` +
        `waiting on ${NEXT_STEP[last] ?? 'the next step'} for ${seconds(Math.max(0, elapsed - lastAt))}. ` +
        `Playwright connected after ${seconds(connected)}. App phases (since its process started): ${phases.slice(1).map(([phase, ms]) => `${phase} ${seconds(ms)}`).join(', ') || 'none (the app never answered)'}` +
        (slowest[1] >= 0 ? `; slowest finished step: up to ${slowest[0]}, ${seconds(slowest[1])}.` : '.'),
      { cause: error },
    );
  }
}

test('opens a new vault with the demo, saves typing to disk, opens a board', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    // The window shows the app from its own in-process server.
    await expect(window).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${port}/`));
    await expectPageTitle(window, 'Welcome');
    expect(await window.title()).toContain('Gumply');
    // Settings live in ~/.config/Gumply in dev and packaged builds alike.
    expect(await app.evaluate(({ app: electronApp }) => electronApp.getName())).toBe('Gumply');
    // The window shows the web app's own title (#ux5cukze sets page and vault).
    const title = await window.title();
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle()))
      .toBe(title);

    // Type in a page: the Markdown file on disk changes.
    const editor = window.getByTestId('editor-content');
    await editor.getByText('Gumply is a quiet place for notes', { exact: false }).click();
    await window.keyboard.press('End');
    await window.keyboard.type(' Typed in the desktop app.');
    await expect(window.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    expect(readFileSync(join(vault, 'Welcome.md'), 'utf8')).toContain('Typed in the desktop app.');

    // A whiteboard opens (the demo "Project map").
    await window.getByTestId('page-item-Gumply demo/Project map.canvas').click();
    await expect(window.getByTestId('board-page')).toBeVisible();
    await expect(window.locator('.react-flow__node').first()).toBeVisible({ timeout: 15_000 });

    if (shots) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1280, 800));
      await window.waitForTimeout(500);
      await window.screenshot({ path: join(shots, 'desktop-board-light.png') });
      for (const theme of ['dark', 'light'] as const) {
        // The in-app theme setting (xvfb has no system theme to follow).
        await window.evaluate((value) => localStorage.setItem('gumply:theme', value), theme);
        await window.getByTestId('page-item-Welcome').click();
        await expectPageTitle(window, 'Welcome');
        await window.reload();
        await expectPageTitle(window, 'Welcome');
        await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
        await window.waitForTimeout(300);
        await window.screenshot({ path: join(shots, `desktop-page-${theme}.png`) });
        await window.getByTestId('page-item-Gumply demo/Project map.canvas').click();
        await expect(window.locator('.react-flow__node').first()).toBeVisible({ timeout: 15_000 });
        await window.waitForTimeout(500);
        await window.screenshot({ path: join(shots, `desktop-board-${theme}.png`) });
      }
    }
  } finally {
    await app.close();
  }
});

test('a new vault gets the demo in the saved interface language (#93yv3ban)', async () => {
  mkdirSync(userData, { recursive: true });
  writeFileSync(
    join(userData, 'gumply-desktop.json'),
    JSON.stringify({ lastVault: null, recentVaults: [], window: null, uiState: { 'gumply:language': 'ru' } }),
  );
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Добро пожаловать');
    expect(existsSync(join(vault, 'Демо Gumply', 'Карта проекта.canvas'))).toBe(true);
  } finally {
    await app.close();
  }
});

test('external links never navigate the window; they go to the system browser', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    // Record shell.openExternal instead of opening a real browser.
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { __opened?: string[] }).__opened = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    const appUrl = window.url();

    // A plain link click, a target=_blank link, window.open and a scripted
    // navigation: none of them leaves the app.
    await window.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'https://example.com/plain';
      link.textContent = 'plain';
      link.id = 'test-plain';
      const blank = document.createElement('a');
      blank.href = 'https://example.com/blank';
      blank.target = '_blank';
      blank.id = 'test-blank';
      blank.textContent = 'blank';
      document.body.append(link, blank);
    });
    // (Clicked from script: the app's full-screen layout covers the body.)
    await window.evaluate(() => (document.getElementById('test-plain') as HTMLAnchorElement).click());
    await window.evaluate(() => (document.getElementById('test-blank') as HTMLAnchorElement).click());
    await window.evaluate(() => window.open('mailto:hello@example.com'));
    await window.evaluate(() => {
      window.location.href = 'https://example.com/scripted';
    });
    await window.evaluate(() => window.open('javascript:alert(1)'));
    await window.waitForTimeout(500);

    expect(window.url()).toBe(appUrl);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const opened = await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []);
    expect(opened).toEqual([
      'https://example.com/plain',
      'https://example.com/blank',
      'mailto:hello@example.com',
      'https://example.com/scripted',
    ]);
  } finally {
    await app.close();
  }
});

test('remembers the vault and the window size for the next start', async () => {
  const first = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  await expectPageTitle(first.window, 'Welcome');
  await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ width: 1000, height: 700 }));
  await first.app.close();

  const settings = JSON.parse(readFileSync(join(userData, 'gumply-desktop.json'), 'utf8'));
  expect(settings).toMatchObject({ lastVault: vault, recentVaults: [vault], window: { width: 1000, height: 700 } });

  // No GUMPLY_DESKTOP_VAULT: the last vault opens straight away, no picker.
  const second = await launch();
  try {
    await expectPageTitle(second.window, 'Welcome');
    const bounds = await second.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
    expect(bounds).toMatchObject({ width: 1000, height: 700 });
  } finally {
    await second.app.close();
  }
});

test('the native menu runs the in-app commands (New Page, New Whiteboard, Search, Import from Notion)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    const click = (id: string) =>
      app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.click(), id);

    await click('new-page');
    await expect(window.getByTestId('page-title-input')).toHaveValue('Untitled');
    await expect.poll(() => readdirSafe(vault)).toContain('Untitled.md');

    await click('new-whiteboard');
    await window.getByTestId('template-blank').click();
    await expect(window.getByTestId('board-page')).toBeVisible();
    await expect.poll(() => readdirSafe(vault).some((name) => name.endsWith('.canvas'))).toBe(true);

    await click('search');
    await expect(window.getByRole('dialog')).toBeVisible();
    await window.keyboard.press('Escape');

    // B4: File → Import from Notion… opens the import dialog.
    await click('import-notion');
    await expect(window.getByTestId('notion-import')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('Help → Open-Source Licences opens THIRD_PARTY_NOTICES (#mbim529b)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    const item = await app.evaluate(({ Menu }) => {
      const help = Menu.getApplicationMenu()!.items.find((entry) => entry.role === 'help');
      const licences = Menu.getApplicationMenu()!.getMenuItemById('licences');
      return { inHelp: Boolean(help?.submenu?.items.some((entry) => entry.id === 'licences')), label: licences?.label ?? null };
    });
    expect(item).toEqual({ inHelp: true, label: 'Open-Source Licences' });
    // Record what it opens instead of launching a viewer on the test machine.
    await app.evaluate(({ shell }) => {
      (globalThis as { openedPath?: string }).openedPath = '';
      shell.openPath = async (path: string) => {
        (globalThis as { openedPath?: string }).openedPath = path;
        return '';
      };
    });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('licences')!.click());
    const opened = await app.evaluate(() => (globalThis as { openedPath?: string }).openedPath ?? '');
    // In dev the repo's notices; packaged, resources/THIRD_PARTY_NOTICES.txt.
    expect(opened).toMatch(/THIRD_PARTY_NOTICES\.(md|txt)$/);
    expect(existsSync(opened)).toBe(true);
    expect(readFileSync(opened, 'utf8')).toContain('# Third-party notices');
  } finally {
    await app.close();
  }
});

test('board export saves through the download handler; other downloads are refused (#yewapn9k)', async () => {
  const downloads = join(scratch, 'downloads');
  mkdirSync(downloads, { recursive: true });
  // The test path skips the native Save dialog (it would wait for a click).
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault, GUMPLY_DESKTOP_DOWNLOAD_DIR: downloads });
  try {
    await expectPageTitle(window, 'Welcome');
    await window.getByTestId('new-board-button').click();
    await window.getByTestId('template-kanban').click();
    await expect(window.getByTestId('board-frame')).toHaveCount(3);
    await window.keyboard.press('Escape');
    await window.getByTestId('board-menu-button').click();
    await window.getByTestId('board-export-png').click();
    await expect.poll(() => readdirSafe(downloads)).toContain('Kanban.png');
    await expect.poll(() => readFileSync(join(downloads, 'Kanban.png')).length).toBeGreaterThan(1000);
    expect(readFileSync(join(downloads, 'Kanban.png')).subarray(1, 4).toString()).toBe('PNG');

    // A download the app didn't make itself (here a data: URL) is refused.
    await window.evaluate(() => {
      const link = document.createElement('a');
      link.href = 'data:text/plain,not-an-export';
      link.download = 'other.txt';
      document.body.append(link);
      link.click();
      link.remove();
    });
    await window.waitForTimeout(500);
    expect(readdirSafe(downloads)).toEqual(['Kanban.png']);
  } finally {
    await app.close();
  }
});

test('the interface language: menus follow it, Settings changes it, the desktop settings keep it (#7h5utv23)', async () => {
  // Saved with the app's other preferences (#c7fzzxk8): the window's storage changes with its random port.
  mkdirSync(userData, { recursive: true });
  writeFileSync(join(userData, 'gumply-desktop.json'), JSON.stringify({ lastVault: null, recentVaults: [], window: null, uiState: { 'gumply:language': 'ru' } }));
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    const menuLabel = (id: string) =>
      app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()!.getMenuItemById(itemId)!.label, id);
    await expect.poll(() => menuLabel('new-page')).toBe('Новая страница');
    await expect(window.getByTestId('new-page-button')).toHaveText('Новая страница');
    await expect(window.locator('html')).toHaveAttribute('lang', 'ru');

    // Switch to English in Settings: the page, the menu and the saved setting follow.
    await window.getByTestId('settings-button').click();
    await window.getByTestId('settings-language').selectOption('en');
    await expect(window.getByTestId('new-page-button')).toHaveText('New page');
    await expect.poll(() => menuLabel('new-page')).toBe('New Page');
    await expect.poll(() => menuLabel('about')).toBe('About Gumply');
    await expect
      .poll(
        () =>
          (JSON.parse(readFileSync(join(userData, 'gumply-desktop.json'), 'utf8')) as { uiState?: Record<string, string> })
            .uiState?.['gumply:language'],
      )
      .toBe('en');
  } finally {
    await app.close();
  }
});

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

test('vault files: documents open in their app, scripts and programs are only revealed', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    mkdirSync(join(vault, 'attachments'), { recursive: true });
    writeFileSync(join(vault, 'attachments', 'report.pdf'), '%PDF-1.4');
    writeFileSync(join(vault, 'attachments', 'run.sh'), '#!/bin/sh\necho pwned\n', { mode: 0o755 });
    // A harmless-looking name pointing at the script.
    symlinkSync(join(vault, 'attachments', 'run.sh'), join(vault, 'attachments', 'innocent.pdf'));

    await app.evaluate(({ shell }) => {
      const log: string[] = [];
      (globalThis as { __files?: string[] }).__files = log;
      shell.openPath = async (path: string) => {
        log.push(`open ${path}`);
        return '';
      };
      shell.showItemInFolder = (path: string) => {
        log.push(`reveal ${path}`);
      };
    });
    for (const name of ['report.pdf', 'run.sh', 'innocent.pdf', '..%2F..%2Fetc%2Fpasswd']) {
      await window.evaluate((file) => window.open(`/api/files/attachments/${file}`), name);
    }
    await window.waitForTimeout(500);
    const log = await app.evaluate(() => (globalThis as { __files?: string[] }).__files ?? []);
    expect(log.map((entry) => entry.replace(vault, '<vault>'))).toEqual([
      'open <vault>/attachments/report.pdf',
      'reveal <vault>/attachments/run.sh',
      'reveal <vault>/attachments/run.sh',
    ]);
  } finally {
    await app.close();
  }
});

test('a big graph is laid out by the worker under the app\'s CSP and settles (#g95wkd9y)', async () => {
  // 2,000 linked notes: over the worker threshold (1,500), so the graph's
  // layout runs in a Web Worker served under the packaged app's strict CSP.
  mkdirSync(vault, { recursive: true });
  for (let i = 0; i < 2000; i += 1) {
    const base = Math.floor(i / 20) * 20;
    writeFileSync(join(vault, `Note ${i}.md`), `See [[Note ${base + ((i - base + 1) % 20)}]] and [[Note ${(i + 97) % 2000}]].\n`);
  }
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  const refused: string[] = [];
  window.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to|graph layout worker/i.test(text)) refused.push(text);
  });
  try {
    await expect(window.getByTestId('page-item-Note 0')).toBeVisible({ timeout: 60_000 });
    await window.getByTestId('sidebar-graph').click();
    const canvas = window.getByTestId('graph-canvas');
    await expect(canvas).toHaveAttribute('data-graph-layout', 'worker');
    // "stopped" on the worker path comes only from the worker's own "done"
    // (the fallback timer marks the view ready, never the engine stopped).
    await expect(canvas).toHaveAttribute('data-graph-engine', 'stopped', { timeout: 120_000 });
    await expect(canvas).toHaveAttribute('data-graph-ready', 'true');
    expect(refused).toEqual([]);
  } finally {
    await app.close();
  }
});

test('opening a folder that already has files writes nothing into it (#pc3wvc2u)', async () => {
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'report.pdf'), '%PDF-1.4');
  writeFileSync(join(vault, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    // An empty sidebar with the "No pages yet" state, not the demo.
    await expect(window.getByTestId('empty-state')).toBeVisible();
    await expect(window.getByTestId('page-item-Welcome')).toHaveCount(0);
    await window.waitForTimeout(500);
    expect(readdirSafe(vault).sort()).toEqual(['report.pdf', 'run.sh']);
  } finally {
    await app.close();
  }
  // Still nothing after the app has closed (no marker, no settings).
  expect(readdirSafe(vault).sort()).toEqual(['report.pdf', 'run.sh']);
});

test('the app under test is isolated from the real session (P11)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    const seen = await app.evaluate(() => ({
      home: process.env.HOME,
      bus: process.env.DBUS_SESSION_BUS_ADDRESS,
      wayland: process.env.WAYLAND_DISPLAY ?? null,
      xdg: Object.entries(process.env).filter(([key]) => key.startsWith('XDG_')),
    }));
    expect(seen.home).toBe(join(scratch, 'home'));
    expect(seen.bus).toBe(process.env.GUMPLY_TEST_DBUS);
    expect(seen.bus).not.toBe(undefined);
    expect(seen.wayland).toBeNull();
    // Every XDG_* dir (config, data, cache, state, runtime) is a scratch dir;
    // none of the user's session/desktop variables reach the app.
    for (const [key, value] of seen.xdg) {
      expect(value, key).toMatch(new RegExp(`^${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
    }
    expect(seen.xdg.map(([key]) => key).sort()).toEqual([
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_RUNTIME_DIR',
      'XDG_STATE_HOME',
    ]);
  } finally {
    await app.close();
  }
});

test('reports the installed app version, not the source default (#2d683n79)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    const appVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
    const health = await window.evaluate(async () => (await fetch('/api/health')).json());
    expect(health.version).toBe(appVersion);
  } finally {
    await app.close();
  }
});

test('quitting right after typing keeps the words, in a page and in a sticky (#3t6v62cb)', async () => {
  // Two launches and two quits: room for a loaded machine (#qq2snvfh).
  test.setTimeout(180_000);
  const first = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  {
    const { app, window } = first;
    await expectPageTitle(window, 'Welcome');
    const body = window.getByTestId('editor').locator('.ProseMirror');
    // The editor is ready for keys before we type (a slow start loses none).
    await expect(body).toHaveAttribute('contenteditable', 'true');
    await body.click();
    await window.keyboard.press('Control+End');
    await window.keyboard.type(' Typed right before quitting.');
    await expect(body).toContainText('Typed right before quitting.');
    // Ctrl+Q at once: well within the 600 ms autosave debounce.
    await quitAndWait(app, 'quit');
  }
  expect(readFileSync(join(vault, 'Welcome.md'), 'utf8')).toContain('Typed right before quitting.');

  // A sticky still in edit mode, then closing the window.
  writeFileSync(join(vault, 'Trip.canvas'), '{"nodes":[],"edges":[]}\n');
  const second = await launch();
  {
    const { app, window } = second;
    await window.evaluate(() => {
      window.location.hash = '#/Trip.canvas';
    });
    const board = window.getByTestId('board');
    await expect(board).toBeVisible();
    const box = await board.boundingBox();
    if (!box) throw new Error('no board');
    await window.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await window.keyboard.type('Book flights');
    await expect(window.getByTestId('board-text-editor')).toHaveValue('Book flights');
    await quitAndWait(app, 'close-window');
  }
  const saved = JSON.parse(readFileSync(join(vault, 'Trip.canvas'), 'utf8')) as { nodes: Array<{ text?: string }> };
  expect(saved.nodes.map((node) => node.text)).toEqual(['Book flights']);
});

test('a preference written while the window closes never asks; the typed words are saved (#ms44vnit)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  await expectPageTitle(window, 'Welcome');
  const body = window.getByTestId('editor').locator('.ProseMirror');
  await expect(body).toHaveAttribute('contenteditable', 'true');
  await body.click();
  await window.keyboard.press('Control+End');
  await window.keyboard.type(' Closed with a preference in flight.');
  // As a board does with its viewport: a gumply:* key is written while the
  // close flush runs, so the preference mirror is busy again at its end.
  await window.evaluate(() => {
    const original = window.__gumplyFlush!;
    window.__gumplyFlush = () => {
      const report = original();
      localStorage.setItem('gumply:theme', 'dark');
      return report;
    };
  });
  // Any dialog would be answered Cancel (keep the app), so the test fails with its reason.
  await app.evaluate(({ dialog }) => {
    const shown = ((globalThis as { __shown?: string[] }).__shown ??= []);
    dialog.showMessageBox = (async (...args: unknown[]) => {
      shown.push((args.at(-1) as { message?: string }).message ?? '');
      return { response: 1, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
  });
  await quitAndWait(app, 'close-window');
  expect(readFileSync(join(vault, 'Welcome.md'), 'utf8')).toContain('Closed with a preference in flight.');
});

test('trash: "Show in file manager" reveals the trashed file and never opens it (#ppag3ugh)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  try {
    await expectPageTitle(window, 'Welcome');
    const trashId = await window.evaluate(async () => {
      const response = await fetch(`/api/pages/${encodeURIComponent('Welcome')}`, { method: 'DELETE' });
      return ((await response.json()) as { trashId: string }).trashId;
    });

    await app.evaluate(({ shell }) => {
      const log: string[] = [];
      (globalThis as { __shell?: string[] }).__shell = log;
      shell.openPath = async (path: string) => {
        log.push(`open ${path}`);
        return '';
      };
      shell.openExternal = async (url: string) => {
        log.push(`external ${url}`);
      };
      shell.showItemInFolder = (path: string) => {
        log.push(`reveal ${path}`);
      };
    });

    // The desktop app offers it in the trash list and on the trashed page.
    await window.evaluate(() => {
      window.location.hash = '#trash';
    });
    const entry = window.getByTestId('trash-item-Welcome');
    await entry.locator('.trash-row').hover();
    await entry.getByTestId('trash-reveal').click();
    await entry.getByRole('button', { name: /Welcome/ }).first().click();
    await window.getByTestId('trashed-reveal').click();
    // Hand-made requests: other ids, traversal, or a missing entry do nothing.
    for (const path of ['/api/trash/..%2F..%2Fetc/reveal', '/api/trash/does-not-exist/reveal', '/api/trash/a.b/reveal']) {
      await window.evaluate((url) => window.open(url), path);
    }
    await window.waitForTimeout(500);

    const log = await app.evaluate(() => (globalThis as { __shell?: string[] }).__shell ?? []);
    const file = `reveal <vault>/.trash/${trashId}/Welcome.md`;
    expect(log.map((line) => line.replace(vault, '<vault>'))).toEqual([file, file]);
    // Still in the trash, untouched.
    expect(readdirSafe(join(vault, '.trash', trashId)).sort()).toContain('Welcome.md');
  } finally {
    await app.close();
  }
});

test('UI preferences survive a relaunch on another port: theme, sidebar, a board view (#c7fzzxk8)', async () => {
  test.setTimeout(180_000); // two launches and a quit (#qq2snvfh)
  let savedView = '';
  {
    const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
    await expectPageTitle(window, 'Welcome');
    writeFileSync(join(vault, 'Trip.canvas'), '{"nodes":[{"id":"a1","type":"text","text":"Hi","x":0,"y":0,"width":200,"height":80}],"edges":[]}\n');
    await expect(window.getByTestId('page-item-Trip.canvas')).toBeVisible({ timeout: 6_000 });
    // System → Light → Dark.
    await window.getByTestId('theme-toggle').click();
    await window.getByTestId('theme-toggle').click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
    await window.getByTestId('sidebar-toggle').click();
    await expect.poll(() => window.evaluate(() => localStorage.getItem('gumply:sidebar'))).toBe('closed');
    // Pan the board (scrolling pans); its view is remembered per board.
    await window.evaluate(() => {
      window.location.hash = '#/Trip.canvas';
    });
    const board = window.getByTestId('board');
    await expect(board).toBeVisible();
    const box = (await board.boundingBox())!;
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await window.mouse.wheel(0, 240);
    await expect
      .poll(() => window.evaluate(() => localStorage.getItem('gumply:board-view:Trip.canvas')))
      .not.toBeNull();
    savedView = (await window.evaluate(() => localStorage.getItem('gumply:board-view:Trip.canvas')))!;
    await quitAndWait(app, 'quit');
  }
  const settings = JSON.parse(readFileSync(join(userData, 'gumply-desktop.json'), 'utf8')) as { uiState: Record<string, string> };
  expect(settings.uiState).toMatchObject({ 'gumply:theme': 'dark', 'gumply:sidebar': 'closed', 'gumply:board-view:Trip.canvas': savedView });

  // A new port is a new origin: its localStorage starts empty, as in every real launch.
  const { app, window } = await launch({ GUMPLY_DESKTOP_PORT: String(port + 1) });
  try {
    await expect(window).toHaveURL(new RegExp(`^http://127\\.0\\.0\\.1:${port + 1}/`));
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await window.evaluate(() => localStorage.getItem('gumply:sidebar'))).toBe('closed');
    await expect(window.getByTestId('sidebar')).toBeHidden();
    expect(await window.evaluate(() => localStorage.getItem('gumply:board-view:Trip.canvas'))).toBe(savedView);
  } finally {
    await app.close();
  }
});

test('a save that never confirms asks before quitting; Cancel keeps the app, "Quit anyway" quits (#8zc7xkgq)', async () => {
  const { app, window } = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  await expectPageTitle(window, 'Welcome');
  // The page reports its saves as not done (a stuck disk), and the dialog's answer is scripted.
  await window.evaluate(() => {
    window.__gumplyFlush = async () => ({
      saved: false,
      ms: 10_000,
      timedOut: true,
      unsaved: [{ kind: 'page', dirty: true, failed: false }],
    });
  });
  const answer = async (response: number) =>
    app.evaluate(({ dialog }, choice) => {
      const shown = ((globalThis as { __shown?: string[] }).__shown ??= []);
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args.at(-1) as { message?: string };
        shown.push(options.message ?? '');
        return { response: choice, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    }, response);

  await answer(1); // Cancel
  await app.evaluate(({ app: electronApp }) => electronApp.quit());
  await expect.poll(() => app.evaluate(() => (globalThis as { __shown?: string[] }).__shown?.length ?? 0)).toBe(1);
  // Still running and usable.
  await expectPageTitle(window, 'Welcome');
  // It says why (#ms44vnit).
  expect(
    await app.evaluate(() => (globalThis as { __gumplyUnsavedDialog?: { reason: string | null } }).__gumplyUnsavedDialog?.reason),
  ).toBe('page still saving (flush took 10.0 s, timed out)');

  await answer(0); // Quit anyway
  await quitAndWait(app, 'quit');
});

