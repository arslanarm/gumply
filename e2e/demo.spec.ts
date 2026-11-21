import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { DEMO_API_URL, DEMO_WEB_URL, DemoApp } from './support/demo-app';
import { waitForBootOnNavigation } from './support/nav';
import { expectPageTitle } from './support/ui';

/**
 * Flow F (polish) — demo vault first run, see wiki `spec/e2e-tests`.
 *
 * Runs against its own app + fresh vault with server-side seeding enabled, so
 * the shared suite (seeding disabled, vault wiped per test) is unaffected.
 */
test.use({ baseURL: DEMO_WEB_URL });

// #dvnb8n2n: the demo folder also holds the "Project map" whiteboard.
const DEMO_TITLES = ['Getting started', 'Graph view', 'Gumply demo', 'Project map', 'Welcome'];

let app: DemoApp;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  app = new DemoApp();
  await app.start();
});

test.afterAll(async () => {
  await app?.stop();
});

// #rqtacq4d: this spec has its own app (cold Vite, first-run seeding), so it
// installs the shared load-aware page-open wait itself, for that app's URL.
test.beforeEach(({ page }, testInfo) => {
  waitForBootOnNavigation(page, testInfo, DEMO_WEB_URL);
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
  await expect(editor).toContainText('Gumply is a quiet place for notes');
  // The title is the only heading at the top: no duplicate "Welcome to Gumply" H1.
  await expect(editor.locator('h1')).toHaveCount(0);
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
  expect(first).toHaveLength(5);
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
  expect(afterRestart).toHaveLength(5);
  expect(new Set(afterRestart.map((item) => item.id)).size).toBe(5);
  expect(afterRestart.map((item) => item.title).sort()).toEqual(DEMO_TITLES);

  await page.getByTestId('page-item-Welcome').click();
  await expectPageTitle(page, 'Welcome');
  await expect(page.getByTestId('editor-content')).toContainText('Gumply is a quiet place');

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
  await expect(dialog).toContainText('Its 3 sub-pages will be deleted too.');
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

test('a Russian first run seeds the demo in Russian (#93yv3ban)', async ({ page, request }) => {
  test.setTimeout(60_000);
  await app.freshVault();
  // The interface language is Russian before the first list of pages.
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await page.goto('/');
  // Right after a server restart the first load also seeds and fetches the
  // Russian chunk; under a full suite's load that can take more than 5 s.
  await expect(page.getByTestId('page-title').or(page.getByTestId('page-title-input')).first()).toBeVisible({
    timeout: 20_000,
  });
  await expectPageTitle(page, 'Добро пожаловать');
  await expect(page.getByTestId('editor-content')).toContainText('Gumply — спокойное место для заметок');
  await expect(page.getByTestId('page-item-Демо Gumply')).toBeVisible();
  const pages = (await (await request.get(`${DEMO_API_URL}/api/pages`)).json()) as { title: string }[];
  expect(pages.map((item) => item.title).sort()).toEqual(
    ['Граф связей', 'Демо Gumply', 'Добро пожаловать', 'Карта проекта', 'Начало работы'].sort(),
  );
  // Its links resolve: the cheat sheet's link opens the Russian page.
  await page.getByTestId('editor-content').getByText('Начало работы').first().click();
  await expectPageTitle(page, 'Начало работы');
});
