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
