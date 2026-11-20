import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DEMO_API_URL, DEMO_WEB_URL, DemoApp } from './support/demo-app';
import { expectPageTitle } from './support/ui';

/**
 * Flow F (polish) — demo vault first run, see wiki `spec/e2e-tests`.
 *
 * Runs against its own app + fresh vault with server-side seeding enabled, so
 * the shared suite (seeding disabled, vault wiped per test) is unaffected.
 */
test.use({ baseURL: DEMO_WEB_URL });

const DEMO_TITLES = ['Getting started', 'Graph view', 'Gumply demo', 'Welcome'];

let app: DemoApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = new DemoApp();
  await app.start();
});

test.afterAll(async () => {
  await app?.stop();
});

test('a fresh vault is seeded once, opens Welcome and never duplicates or re-seeds', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);

  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(`${message.text()} @ ${message.location().url}`);
    }
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  // First load: the server reports the new-vault page once, so Welcome opens.
  await page.goto('/');
  await expectPageTitle(page, 'Welcome');
  const editor = page.getByTestId('editor-content');
  await expect(editor).toContainText('Welcome to Gumply');
  await expect(editor.getByRole('checkbox')).toHaveCount(2);
  await expect(page.getByTestId('page-item-Welcome')).toBeVisible();
  await expect(page.getByTestId('page-item-Gumply demo')).toBeVisible();

  // The once-only marker is on disk.
  expect(existsSync(app.marker)).toBe(true);
  const marker = JSON.parse(readFileSync(app.marker, 'utf8')) as { demoSeededAt?: unknown };
  expect(typeof marker.demoSeededAt).toBe('string');

  const first = (await (await request.get(`${DEMO_API_URL}/api/pages`)).json()) as {
    id: string;
    title: string;
  }[];
  expect(first).toHaveLength(4);
  expect(first.map((item) => item.title).sort()).toEqual(DEMO_TITLES);

  // Second load on the same server: no new-vault signal, no duplicate pages.
  // The `#/Welcome` deep link is kept, so Welcome stays open.
  await page.reload();
  await expectPageTitle(page, 'Welcome');
  await expect(page.getByTestId('page-item-Welcome')).toHaveCount(1);

  // Restart the API against the same vault: the marker must stop re-seeding.
  await app.restartServer();
  await page.reload();
  await expectPageTitle(page, 'Welcome');

  const afterRestart = (await (await request.get(`${DEMO_API_URL}/api/pages`)).json()) as {
    id: string;
    title: string;
  }[];
  expect(afterRestart).toHaveLength(4);
  expect(new Set(afterRestart.map((item) => item.id)).size).toBe(4);
  expect(afterRestart.map((item) => item.title).sort()).toEqual(DEMO_TITLES);

  await page.getByTestId('page-item-Welcome').click();
  await expectPageTitle(page, 'Welcome');
  await expect(page.getByTestId('editor-content')).toContainText('Welcome to Gumply');

  // Delete every page through the UI, like a user emptying the demo, then
  // restart the API on the same vault. The marker must keep it empty: the old
  // client-side seeding re-created the demo for a user who had emptied it.
  await page.getByTestId('delete-page-button-page').click();
  await expect(page.getByTestId('page-item-Welcome')).toHaveCount(0);
  // Deleting the open page opens the next one (the demo folder).
  await expectPageTitle(page, 'Gumply demo');

  await page.getByTestId('delete-page-button-page').click();
  const dialog = page.getByRole('dialog', { name: 'Delete “Gumply demo”?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Its 2 sub-pages will be deleted too.');
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('sidebar-empty')).toBeVisible();

  const listPages = async () =>
    (await (await request.get(`${DEMO_API_URL}/api/pages`)).json()) as {
      id: string;
      title: string;
    }[];
  expect(await listPages()).toHaveLength(0);
  expect(existsSync(app.marker)).toBe(true);

  await app.restartServer();
  await page.reload();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  await expect(page.getByTestId('page-item-Welcome')).toHaveCount(0);
  expect(await listPages()).toHaveLength(0);

  expect(consoleErrors).toEqual([]);
});
