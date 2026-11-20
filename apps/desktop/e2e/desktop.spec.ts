import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  process.platform === 'linux' && process.env.GUMPLY_DESKTOP_HEADLESS !== '1',
  'Run via `npm run desktop:test` (virtual display); refusing to open windows on the real desktop.',
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

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; window: Page }> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Never on the user's Wayland desktop: X11 (xvfb-run) only.
    if (value !== undefined && key !== 'WAYLAND_DISPLAY') base[key] = value;
  }
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
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getTitle())).toBe('Gumply — vault');

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
    await expect(window.getByTestId('board-page')).toBeVisible();
    await expect.poll(() => readdirSafe(vault).some((name) => name.endsWith('.canvas'))).toBe(true);

    await click('search');
    await expect(window.getByRole('dialog')).toBeVisible();
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
