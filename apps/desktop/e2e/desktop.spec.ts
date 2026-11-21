import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
test.afterEach(() => rmSync(scratch, { recursive: true, force: true }));

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

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> {
  const base = isolatedEnv();
  const app = await electron.launch({
    args: ['--ozone-platform=x11', appDir],
    env: {
      ...base,
      GUMPLY_DESKTOP_USER_DATA: userData,
      GUMPLY_DESKTOP_PORT: String(port),
      ...env,
    },
  });
  const window = await app.firstWindow();
  return { app, window };
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

test('the native menu runs the in-app commands (New Page, New Whiteboard, Search)', async () => {
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
  const first = await launch({ GUMPLY_DESKTOP_VAULT: vault });
  {
    const { app, window } = first;
    await expectPageTitle(window, 'Welcome');
    const body = window.getByTestId('editor').locator('.ProseMirror');
    await body.click();
    await window.keyboard.press('Control+End');
    await window.keyboard.type(' Typed right before quitting.');
    // Ctrl+Q at once: well within the 600 ms autosave debounce.
    const closed = app.waitForEvent('close');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await closed;
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
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await closed;
  }
  const saved = JSON.parse(readFileSync(join(vault, 'Trip.canvas'), 'utf8')) as { nodes: Array<{ text?: string }> };
  expect(saved.nodes.map((node) => node.text)).toEqual(['Book flights']);
});
