import type { DesktopUpdatesState } from '@gumply/core';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * spec/auto-update §9 (#a7qepp99): Settings → Updates and the update notice.
 * The desktop app's routes (`/api/desktop/updates`, desktop only) are stubbed
 * here, and /api/health says `desktop: true`; the updater itself is tested in
 * the desktop unit tests and the CI update run.
 */

function state(overrides: Partial<DesktopUpdatesState> = {}): DesktopUpdatesState {
  return {
    kind: 'nsis',
    mode: 'auto',
    modes: ['auto', 'notify', 'off'],
    status: 'idle',
    currentVersion: '0.9.0',
    version: null,
    releaseUrl: null,
    lastChecked: null,
    error: null,
    ...overrides,
  };
}

async function stubDesktop(page: Page, initial: DesktopUpdatesState) {
  let current = initial;
  const calls: string[] = [];
  await page.route('**/api/health', async (route) => {
    try {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), desktop: true } });
    } catch {
      // The page closed while the request was in flight (the test ended).
    }
  });
  await page.route('**/api/desktop/updates**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    calls.push(`${request.method()} ${path}`);
    if (request.method() === 'POST' && path.endsWith('/check')) {
      current = { ...current, status: 'up-to-date', lastChecked: new Date().toISOString() };
    } else if (request.method() === 'PUT' && path.endsWith('/settings')) {
      current = { ...current, mode: (request.postDataJSON() as { mode: DesktopUpdatesState['mode'] }).mode };
    } else if (request.method() === 'POST' && path.endsWith('/restart')) {
      return route.fulfill({ status: 202, json: { ok: true } });
    }
    return route.fulfill({ json: current });
  });
  return { calls };
}

/** What the desktop app sends when the state changes. */
async function push(page: Page, next: DesktopUpdatesState) {
  await page.evaluate((detail) => window.dispatchEvent(new CustomEvent('gumply:updates', { detail })), next);
}

async function openUpdates(page: Page) {
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-updates').click();
  await expect(page.getByTestId('updates-settings')).toBeVisible();
}

test('the browser app has no Updates settings and no notice', async ({ page, vault }) => {
  await vault.seed([{ title: 'Notes', content: 'Hello.' }]);
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();
  await page.getByTestId('settings-button').click();
  await expect(page.getByTestId('settings-mcp')).toBeVisible();
  await expect(page.getByTestId('settings-updates')).toHaveCount(0);
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
});

test('Settings → Updates: the three choices, Check now and the last check', async ({ page }) => {
  const { calls } = await stubDesktop(page, state());
  await page.goto('/');
  await openUpdates(page);
  const dialog = page.getByTestId('updates-settings');
  await expect(dialog).toContainText('You have Gumply 0.9.0.');
  await expect(page.getByTestId('updates-mode-auto')).toBeChecked();
  await expect(dialog.getByRole('radio')).toHaveCount(3);

  await page.getByTestId('updates-mode-notify').check();
  await expect.poll(() => calls).toContain('PUT /api/desktop/updates/settings');
  await expect(page.getByTestId('updates-mode-notify')).toBeChecked();

  await page.getByTestId('updates-check').click();
  await expect(page.getByTestId('updates-status')).toHaveText('Gumply 0.9.0 is up to date.');
  await expect(page.getByTestId('updates-last-checked')).toContainText('Last checked');
  await expect(page.getByTestId('updates-privacy')).toContainText('GitHub sees your IP address');

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a Check now answer that arrives after a newer push never puts the older state back (#7vyqfcpn)', async ({ page }) => {
  // The v0.9.2 tag build: the route answered "downloading" (taken mid-download), but the sha512
  // failure's push ("available" + error) reached the window first; the late answer then put
  // "downloading" back for good. Every state is stamped (seq); the window keeps the newer one.
  await page.route('**/api/health', async (route) => {
    try {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), desktop: true } });
    } catch {
      // The page closed while the request was in flight.
    }
  });
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/desktop/updates**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/check')) {
      await held; // answered only after the newer push is in
      return route.fulfill({ json: state({ status: 'downloading', version: '0.9.3', seq: 3 }) });
    }
    return route.fulfill({ json: state({ status: 'up-to-date', seq: 1 }) });
  });
  await page.goto('/');
  await openUpdates(page);
  const status = page.getByTestId('updates-status');
  const answered = page.waitForResponse((response) => response.url().endsWith('/api/desktop/updates/check'));
  await page.getByTestId('updates-check').click();
  await push(page, state({ status: 'available', version: '0.9.3', error: 'sha512 checksum mismatch', seq: 5 }));
  await expect(status).toContainText('Gumply 0.9.3 is available.');
  release();
  await answered;
  await page.waitForTimeout(500); // the late answer has had every chance to apply
  await expect(status).toContainText('Gumply 0.9.3 is available.');
  await expect(status).not.toContainText('is downloading');
});

test('macOS and .deb get no automatic choice, and a download hint', async ({ page }) => {
  await stubDesktop(
    page,
    state({ kind: 'mac', mode: 'notify', modes: ['notify', 'off'], status: 'available', version: '0.9.1', releaseUrl: 'https://github.com/arslanarm/gumply/releases/tag/v0.9.1' }),
  );
  await page.goto('/');
  await openUpdates(page);
  await expect(page.getByTestId('updates-mode-auto')).toHaveCount(0);
  await expect(page.getByTestId('updates-settings').getByRole('radio')).toHaveCount(2);
  await expect(page.getByTestId('updates-hint')).toHaveText('Download the new version and replace Gumply in Applications.');
  await expect(page.getByTestId('updates-release')).toHaveAttribute('href', 'https://github.com/arslanarm/gumply/releases/tag/v0.9.1');
});

test('the notice: ready → Restart now goes through the app; Later hides it; it never takes focus', async ({ page, vault }) => {
  await vault.seed([{ title: 'Notes', content: 'Hello.' }]);
  const { calls } = await stubDesktop(page, state());
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();
  await expect(page.getByTestId('update-notice')).toHaveCount(0);

  // Typing in a page: a notice arriving mustn't move the caret.
  await page.getByTestId('editor-content').click();
  const focusedBefore = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? '');
  await push(page, state({ status: 'ready', version: '0.9.1', releaseUrl: 'https://github.com/arslanarm/gumply/releases/tag/v0.9.1' }));
  const notice = page.getByTestId('update-notice');
  await expect(notice).toContainText('Gumply 0.9.1 is ready. It installs when you quit.');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.className ?? '')).toBe(focusedBefore);
  await expect(page.getByTestId('update-notice-release')).toHaveText("What's new");

  await page.getByTestId('update-notice-restart').click();
  await expect.poll(() => calls).toContain('POST /api/desktop/updates/restart');

  await page.getByTestId('update-notice-later').click();
  await expect(notice).toHaveCount(0);
});

test('the notice: an AI app still running keeps the update pending, and says so', async ({ page }) => {
  await stubDesktop(page, state({ status: 'pending-running', version: '0.9.1' }));
  await page.goto('/');
  await expect(page.getByTestId('update-notice')).toHaveText(/Update ready, will install when Gumply and AI apps using it are closed\./);
  await expect(page.getByTestId('update-notice-restart')).toHaveCount(0);
});

test('with updates off, no notice; Settings still shows the state', async ({ page }) => {
  await stubDesktop(page, state({ mode: 'off', status: 'available', version: '0.9.1', releaseUrl: 'https://github.com/arslanarm/gumply/releases/tag/v0.9.1' }));
  await page.goto('/');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('update-notice')).toHaveCount(0);
  await openUpdates(page);
  await expect(page.getByTestId('updates-status')).toHaveText('Gumply 0.9.1 is available.');
});

test('Russian: the notice and Settings → Updates', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await stubDesktop(page, state({ kind: 'deb', mode: 'notify', modes: ['notify', 'off'], status: 'available', version: '0.9.1', releaseUrl: 'https://github.com/arslanarm/gumply/releases/tag/v0.9.1' }));
  await page.goto('/');
  const notice = page.getByTestId('update-notice');
  await expect(notice).toContainText('Вышла версия Gumply 0.9.1.');
  await expect(notice).toContainText('Установлено из .deb: обновите через менеджер пакетов или новым .deb.');
  await expect(page.getByTestId('update-notice-release')).toHaveText('Скачать');
  await openUpdates(page);
  await expect(page.getByTestId('updates-settings')).toContainText('Обновления');
  await expect(page.getByTestId('updates-mode-notify')).toBeChecked();
});
