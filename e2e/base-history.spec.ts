import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * N1 (#kw8th869, D41): a database view (.base) has version history like a
 * page: ⋯ → History… lists its versions, previews one as its YAML text, shows
 * the changes line by line, and restores it byte for byte (the view below has
 * a comment and spacing that a YAML round trip would lose).
 */
const ORIGINAL = '# my view, kept as written\nviews:\n  - type: table\n    name:   Tasks\n    order: [file.name]\n';

test('a database view: History… previews its YAML, shows the changes, and restores the exact bytes', async ({ page, request, vault }) => {
  await vault.reset();
  // Written to disk as is (a comment and spacing a round trip would lose), under a name of its
  // own: a file reappearing outside Gumply at a path with history is "recreated" (D41), and keeps it.
  const name = `Tasks ${Date.now().toString(36)}`;
  const id = `${name}.base`;
  const file = path.join(E2E_VAULT, id);
  await writeFile(file, ORIGINAL);
  await expect.poll(async () => (await request.get(`/api/bases/${encodeURIComponent(id)}`)).status(), { timeout: 15_000 }).toBe(200);

  // A save from the view (as the view's own controls make): the old bytes go into history first.
  const before = await (await request.get(`/api/bases/${encodeURIComponent(id)}`)).json();
  const config = { ...before.config, views: before.config.views.map((view: { name: string }, i: number) => (i === 0 ? { ...view, name: 'Renamed' } : view)) };
  const saved = await request.put(`/api/bases/${encodeURIComponent(id)}`, { data: { config, expectedUpdated: before.meta.updated } });
  expect(saved.ok()).toBe(true);
  expect(await readFile(file, 'utf8')).not.toBe(ORIGINAL);

  // The view is open while its history is restored: it must show the restored version at once.
  await page.goto(`/#/${encodeURIComponent(id)}`);
  const tabs = page.getByTestId('base-view').getByRole('tablist');
  await expect(tabs).toContainText('Renamed');
  await page.getByTestId(`page-item-${id}`).hover();
  await page.getByTestId(`page-menu-button-${id}`).click();
  await expect(page.getByTestId(`page-menu-${id}`).getByRole('menuitem', { name: 'History…' })).toBeVisible();
  await page.getByTestId(`page-history-${id}`).click();

  const dialog = page.getByTestId('history-dialog');
  await expect(dialog).toBeVisible();
  const versions = dialog.getByTestId('history-item');
  await expect(versions).toHaveCount(1);
  await versions.first().click();
  // The version as its file: YAML text, comment and all.
  await expect(dialog.getByTestId('history-base-preview')).toContainText('# my view, kept as written');
  await expect(dialog.getByTestId('history-base-preview')).toContainText('Tasks');

  await dialog.getByTestId('history-view-changes').click();
  const diff = dialog.getByTestId('history-diff');
  await expect(diff).toContainText('Tasks');
  await expect(diff).toContainText('Renamed');

  await dialog.getByTestId('history-restore').click();
  await expect(dialog.getByTestId('history-status')).toContainText('Undo is at the top of the list');
  // Byte for byte, the comment and the spacing included.
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).toBe(ORIGINAL);
  await expect(versions.filter({ hasText: 'Before restore' })).toHaveCount(1);
  await dialog.getByTestId('history-close').click();
  // The open view took the restored version without a reload or the next poll.
  await expect(tabs).toContainText('Tasks', { timeout: 3_000 });
  await expect(tabs).not.toContainText('Renamed');
});

// #wrr9fjn9: a view change still on its way when you press Restore goes out first, and is then kept as
// the "before restore" version: the restore neither overtakes it (a false "changed on disk") nor loses it.
const GALLERY = '# a gallery, kept as written\nviews:\n  - type: cards\n    name: Gallery\n    order: [file.name]\n';

test('a database view: Restore waits for a view change still being saved, then keeps it as "Before restore"', async ({ page, request, vault }) => {
  await vault.reset();
  const id = `Gallery ${Date.now().toString(36)}.base`;
  const file = path.join(E2E_VAULT, id);
  await writeFile(file, GALLERY);
  await expect.poll(async () => (await request.get(`/api/bases/${encodeURIComponent(id)}`)).status(), { timeout: 15_000 }).toBe(200);
  // One saved change, so the original is a version to go back to.
  const before = await (await request.get(`/api/bases/${encodeURIComponent(id)}`)).json();
  const config = { ...before.config, views: before.config.views.map((view: { name: string }, i: number) => (i === 0 ? { ...view, name: 'Cards' } : view)) };
  expect((await request.put(`/api/bases/${encodeURIComponent(id)}`, { data: { config, expectedUpdated: before.meta.updated } })).ok()).toBe(true);

  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('base-view').getByRole('tablist')).toContainText('Cards');

  // The view's next save is held on its way to the server.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let seen = false;
  await page.route(/\/api\/bases\//, async (route) => {
    if (seen || route.request().method() !== 'PUT') return route.continue();
    seen = true;
    await held;
    await route.continue();
  });
  const restores: number[] = [];
  page.on('request', (sent) => {
    if (sent.method() === 'POST' && sent.url().includes('/restore')) restores.push(Date.now());
  });
  await page.getByTestId('base-settings-button').click();
  await page.getByTestId('base-setting-cardSize').fill('300');
  await expect.poll(() => seen).toBe(true);
  await page.keyboard.press('Escape');

  await page.getByTestId(`page-item-${id}`).hover();
  await page.getByTestId(`page-menu-button-${id}`).click();
  await page.getByTestId(`page-history-${id}`).click();
  const dialog = page.getByTestId('history-dialog');
  const versions = dialog.getByTestId('history-item');
  await expect(versions).toHaveCount(1);
  await versions.first().click();
  await dialog.getByTestId('history-restore').click();

  await page.waitForTimeout(500);
  const releasedAt = Date.now();
  release();

  await expect(dialog.getByTestId('history-status')).toContainText('Undo is at the top of the list');
  // The restore went out only after the view's save was let through (without the flush it meets a
  // false "changed while you were looking", which the status line above catches).
  expect(restores).toHaveLength(1);
  expect(restores[0]!).toBeGreaterThanOrEqual(releasedAt);
  await expect.poll(() => readFile(file, 'utf8'), { timeout: 10_000 }).toBe(GALLERY);
  // The held change wasn't lost: it's the version the restore replaced.
  const listed = await (await request.get(`/api/history/${encodeURIComponent(id)}`)).json();
  const beforeRestore = listed.items.find((entry: { reason?: string }) => entry.reason === 'before-restore');
  expect(beforeRestore).toBeTruthy();
  const replaced = await (await request.get(`/api/history/${encodeURIComponent(id)}/${encodeURIComponent(beforeRestore.file)}`)).text();
  expect(replaced).toContain('cardSize: 300');
  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'conflict');
});
