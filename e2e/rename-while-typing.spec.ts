import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #im3em6tq (F6, F7): renaming a heavily linked page while typing in it.
 * The rename's link rewrites take seconds; meanwhile the typing must not meet
 * the rename as a 409 ("changed on disk"), it must land in the renamed file,
 * and our own rewrites must never show as "Syncing changes…". The sidebar says
 * what is going on instead.
 */
const LINKERS = 1200;

test('typing during a slow rename saves to the renamed file: no conflict, no "Syncing", a renaming status', async ({ page, request }) => {
  test.setTimeout(180_000);
  // The linking pages as plain files in one folder (one root, so the reset is one delete).
  await fs.mkdir(path.join(E2E_VAULT, 'Linkers'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Hub.md'), 'The hub.\n');
  for (let i = 0; i < LINKERS; i += 100) {
    await Promise.all(
      Array.from({ length: Math.min(100, LINKERS - i) }, (_, j) => fs.writeFile(path.join(E2E_VAULT, 'Linkers', `Linker ${i + j}.md`), `See [[Hub]] (${i + j}).\n`)),
    );
  }
  // Wait until the server has them all and the arrival burst is over.
  await expect
    .poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Linkers/')).length, { timeout: 60_000 })
    .toBe(LINKERS);
  await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).headers()['x-gumply-syncing'] ?? 'off', { timeout: 15_000 }).toBe('off');

  await page.goto('/#/Hub');
  await expect(page.getByTestId('editor-content')).toContainText('The hub.');

  // Everything the save status and the sidebar status show, sampled until the end.
  await page.evaluate(() => {
    const seen = { states: new Set<string>(), status: new Set<string>() };
    (window as unknown as { __seen: typeof seen }).__seen = seen;
    setInterval(() => {
      const state = document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state');
      if (state) seen.states.add(state);
      const status = document.querySelector('[data-testid="sidebar-syncing"]')?.textContent?.trim();
      if (status) seen.status.add(status);
    }, 50);
  });

  await page.getByTestId('page-item-Hub').hover();
  await page.getByTestId('page-menu-button-Hub').click();
  await page.getByTestId('rename-page-Hub').click();
  await page.getByTestId('page-rename-input-Hub').fill('Hub renamed');
  await page.keyboard.press('Enter');

  // Type while the rename's link rewrites run.
  await page.getByTestId('editor-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Typed during the rename, every word kept.', { delay: 40 });

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 120_000 });
  await expect.poll(() => decodeURIComponent(new URL(page.url()).hash.replace(/^#\//, '')), { timeout: 120_000 }).toBe('Hub renamed');
  const text = await fs.readFile(path.join(E2E_VAULT, 'Hub renamed.md'), 'utf8');
  expect(text).toContain('Typed during the rename, every word kept.');
  expect(await fs.readFile(path.join(E2E_VAULT, 'Linkers', 'Linker 7.md'), 'utf8')).toContain('[[Hub renamed]]');

  // A little longer: the watcher's events for our own rewrites arrive after the rename too.
  await page.waitForTimeout(3_000);
  const seen = await page.evaluate(() => {
    const value = (window as unknown as { __seen: { states: Set<string>; status: Set<string> } }).__seen;
    return { states: [...value.states], status: [...value.status] };
  });
  expect(seen.states, 'never "This page changed on disk"').not.toContain('conflict');
  expect(seen.status, 'our own rewrites are not a sync').not.toContain('Syncing changes…');
  expect(seen.status.some((status) => status.startsWith('Renaming “Hub”'))).toBe(true);
});

test('a rename that fails: the typing held behind it still saves, to the old file, with no conflict', async ({ page, vault }) => {
  await vault.seed([{ title: 'Solo', content: 'Start.' }]);
  // The rename request is held for 3 s, then fails (the server's answer to a title PUT).
  await page.route(
    (url) => url.pathname === '/api/pages/Solo',
    async (route) => {
      const request = route.request();
      if (request.method() === 'PUT' && (request.postDataJSON() as { title?: string } | null)?.title !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Rename failed (test)' }) });
        return;
      }
      await route.continue();
    },
  );
  await page.goto('/#/Solo');
  await expect(page.getByTestId('editor-content')).toContainText('Start.');
  await page.evaluate(() => {
    const states = new Set<string>();
    (window as unknown as { __states: Set<string> }).__states = states;
    setInterval(() => {
      const state = document.querySelector('[data-testid="save-status"]')?.getAttribute('data-state');
      if (state) states.add(state);
    }, 50);
  });

  await page.getByTestId('page-item-Solo').hover();
  await page.getByTestId('page-menu-button-Solo').click();
  await page.getByTestId('rename-page-Solo').click();
  await page.getByTestId('page-rename-input-Solo').fill('Solo renamed');
  await page.keyboard.press('Enter');
  await page.getByTestId('editor-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Typed while the rename failed.', { delay: 30 });

  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  // The save waited for the rename, which failed: it went to the old id, with its old version.
  await expect.poll(() => fs.readFile(path.join(E2E_VAULT, 'Solo.md'), 'utf8'), { timeout: 15_000 }).toContain('Start. Typed while the rename failed.');
  await expect(fs.access(path.join(E2E_VAULT, 'Solo renamed.md'))).rejects.toThrow();
  const states = await page.evaluate(() => [...(window as unknown as { __states: Set<string> }).__states]);
  expect(states).not.toContain('conflict');
  expect(decodeURIComponent(new URL(page.url()).hash.replace(/^#\//, ''))).toBe('Solo');
});

test('renaming a page the open page links to, right after typing in it: the typing is saved, never dropped by the reload', async ({ page, vault }) => {
  // A small vault: the rename itself is fast; the typing is still in the editor's autosave delay.
  await vault.seed([
    { title: 'Hub', content: 'The hub.' },
    { title: 'Writer', content: 'Notes about [[Hub]].' },
  ]);
  await page.goto('/#/Writer');
  await expect(page.getByTestId('editor-content')).toContainText('Notes about');
  await page.getByTestId('editor-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Typed just before the rename.');
  // At once, before the autosave fires: rename Hub from the sidebar.
  await page.getByTestId('page-item-Hub').hover();
  await page.getByTestId('page-menu-button-Hub').click();
  await page.getByTestId('rename-page-Hub').click();
  await page.getByTestId('page-rename-input-Hub').fill('Hub renamed');
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('page-item-Hub renamed')).toBeVisible();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 30_000 });
  // The typing is on disk, and the rename rewrote the link in it.
  await expect
    .poll(() => fs.readFile(path.join(E2E_VAULT, 'Writer.md'), 'utf8'), { timeout: 15_000 })
    .toContain('Typed just before the rename.');
  const text = await fs.readFile(path.join(E2E_VAULT, 'Writer.md'), 'utf8');
  expect(text).toContain('[[Hub renamed]]');
  await expect(page.getByTestId('editor-content')).toContainText('Typed just before the rename.');
});
