import { test, expect, type Page } from '@playwright/test';
import { DEMO_API_URL, DEMO_WEB_URL, DemoApp } from './support/demo-app';
import { waitForBootOnNavigation } from './support/nav';

/**
 * #2xx3uae4: the local server goes away and comes back (the browser version;
 * the desktop app starts its server first). Its own app, as demo.spec has, so
 * the API can really stop and start behind the web app's Vite proxy.
 *
 * - A page that couldn't be fetched says the server can't be reached, never
 *   "This page doesn't exist", and loads by itself once the server is back.
 * - "Couldn't save" is retried by itself once the server is back; a manual
 *   Retry gives the keys back to the editor. A save conflict is never retried
 *   by itself: it waits for the user's choice.
 */
test.use({ baseURL: DEMO_WEB_URL });

let app: DemoApp;

// Each test waits for the server to stop and start, sometimes twice: more than the default 30 s.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(150_000);
  app = new DemoApp();
  await app.start();
  await app.warmUp(browser);
});

test.afterAll(async () => {
  await app?.stop();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !app) return;
  await testInfo.attach('demo-app logs', { body: app.recentLogs().join('\n'), contentType: 'text/plain' });
});

test.beforeEach(({ page }, testInfo) => {
  waitForBootOnNavigation(page, testInfo, DEMO_WEB_URL);
});

async function makePage(title: string, content: string): Promise<string> {
  const response = await fetch(`${DEMO_API_URL}/api/pages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, content }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

const fileText = async (id: string) =>
  ((await (await fetch(`${DEMO_API_URL}/api/pages/${encodeURIComponent(id)}`)).json()) as { content: string }).content;

async function openPage(page: Page, id: string, text: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toContainText(text, { timeout: 30_000 });
}

test('a page opened while the server is down loads by itself once it is back; never "doesn\'t exist" (F8)', async ({ page }) => {
  const id = await makePage('Reconnect one', 'First line.');
  const other = await makePage('Reconnect two', 'Second page.');
  await openPage(page, id, 'First line.');

  // Opened while the server is down (a fresh load).
  await app.stopServer();
  await page.goto(`/#/${encodeURIComponent(other)}`);
  await page.reload();
  await expect(page.getByTestId('server-error').or(page.getByTestId('page-unreachable')).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('page-not-found')).toHaveCount(0);
  await app.startApi();
  await expect(page.getByTestId('editor-content')).toContainText('Second page.', { timeout: 30_000 });
  await expect(page.getByTestId('page-not-found')).toHaveCount(0);

  // Moving to another page while it's down (the tree is already there).
  await app.stopServer();
  await page.getByTestId(`page-item-${id}`).click();
  await expect(page.getByTestId('page-unreachable')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('page-unreachable')).toContainText("This page opens as soon as Gumply's local server is back.");
  await expect(page.getByTestId('page-not-found')).toHaveCount(0);
  // Retry while it's still down keeps focus on Retry; once it's back, the page opens with the keys in it.
  await page.getByTestId('page-unreachable-retry').click();
  await expect(page.getByTestId('page-unreachable-retry')).toBeFocused({ timeout: 30_000 });
  await app.startApi();
  await expect(page.getByTestId('editor-content')).toContainText('First line.', { timeout: 30_000 });
  await expect(page.getByTestId('editor-content')).toBeFocused();

  // A real 404 from a server that answers still says so.
  await page.goto('/#/No%20such%20page%20here');
  await expect(page.getByTestId('page-not-found')).toBeVisible({ timeout: 30_000 });
});

test('"Couldn\'t save" is retried by itself once the server is back; Retry gives focus back (F9)', async ({ page }) => {
  const id = await makePage('Reconnect save', 'Saved line.');
  await openPage(page, id, 'Saved line.');
  const body = page.getByTestId('editor-content');
  await body.getByText('Saved line.', { exact: true }).click();
  await page.keyboard.press('End');

  await app.stopServer();
  await page.keyboard.type(' Typed while down');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await app.startApi();
  // No click: the next successful poll retries the save.
  await expect.poll(() => fileText(id), { timeout: 30_000 }).toContain('Saved line. Typed while down');
  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'error');

  // A manual Retry while it's still down: the keys go back to the editor.
  await app.stopServer();
  await page.keyboard.type(' and more');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await page.getByTestId('save-retry').click();
  await page.keyboard.type(' after Retry');
  await expect(body).toContainText('Typed while down and more after Retry');
  await app.startApi();
  await expect.poll(() => fileText(id), { timeout: 30_000 }).toContain('Typed while down and more after Retry');
});

test('a save conflict is never retried by itself: it waits for the user (F9)', async ({ page }) => {
  const id = await makePage('Reconnect conflict', 'Saved line.');
  let conflicts = 1;
  let puts = 0;
  await page.route(`**/api/pages/${encodeURIComponent(id)}`, async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts += 1;
    if (conflicts > 0) {
      conflicts -= 1;
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This page changed on disk.' }) });
    }
    return route.continue();
  });
  await openPage(page, id, 'Saved line.');
  await page.getByTestId('editor-content').getByText('Saved line.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mine');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict', { timeout: 30_000 });
  const before = puts;
  // Several polls succeed meanwhile (every 2 s): none of them saves.
  await page.waitForTimeout(7_000);
  expect(puts).toBe(before);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict');
  expect(await fileText(id)).not.toContain('Mine');
});

test('History says it couldn\'t load, with Retry, never an empty version; and loads by itself once the server is back', async ({ page }) => {
  const id = await makePage('Reconnect history', 'Version one.');
  const saved = await fetch(`${DEMO_API_URL}/api/pages/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: 'Version two.' }),
  });
  expect(saved.status).toBe(200);
  await openPage(page, id, 'Version two.');
  const openHistory = async () => {
    await page.getByTestId(`page-item-${id}`).hover();
    await page.getByTestId(`page-menu-button-${id}`).click();
    await page.getByTestId(`page-history-${id}`).click();
  };

  // Opened while the server is down: the list says so, with Retry.
  await app.stopServer();
  await openHistory();
  const dialog = page.getByTestId('history-dialog');
  await expect(dialog.getByTestId('history-list-error')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId('history-list-retry')).toBeVisible();
  await expect(dialog.getByTestId('history-empty')).toHaveCount(0);
  await app.startApi();
  await expect(dialog.getByTestId('history-item').first()).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId('history-list-error')).toHaveCount(0);

  // A version picked while it's down: an error with Retry, not an empty preview.
  await app.stopServer();
  await dialog.getByTestId('history-item').first().click();
  await expect(dialog.getByTestId('history-version-error')).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByTestId('history-version-retry')).toBeVisible();
  await app.startApi();
  await expect(dialog.getByTestId('history-version-error')).toHaveCount(0, { timeout: 30_000 });
  await expect(dialog.getByTestId('history-preview')).toContainText('Version one.');
});
