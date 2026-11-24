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

test('a database view: History… previews its YAML, shows the changes, and restores the exact bytes', async ({ page, request }) => {
  const file = path.join(E2E_VAULT, 'Tasks.base');
  await writeFile(file, ORIGINAL);
  await expect.poll(async () => (await request.get('/api/bases/Tasks.base')).status(), { timeout: 15_000 }).toBe(200);

  // A save from the view (as the view's own controls make): the old bytes go into history first.
  const before = await (await request.get('/api/bases/Tasks.base')).json();
  const config = { ...before.config, views: before.config.views.map((view: { name: string }, i: number) => (i === 0 ? { ...view, name: 'Renamed' } : view)) };
  const saved = await request.put('/api/bases/Tasks.base', { data: { config, expectedUpdated: before.meta.updated } });
  expect(saved.ok()).toBe(true);
  expect(await readFile(file, 'utf8')).not.toBe(ORIGINAL);

  // The view is open while its history is restored: it must show the restored version at once.
  await page.goto('/#/Tasks.base');
  const tabs = page.getByTestId('base-view').getByRole('tablist');
  await expect(tabs).toContainText('Renamed');
  await page.getByTestId('page-item-Tasks.base').hover();
  await page.getByTestId('page-menu-button-Tasks.base').click();
  await expect(page.getByTestId('page-menu-Tasks.base').getByRole('menuitem', { name: 'History…' })).toBeVisible();
  await page.getByTestId('page-history-Tasks.base').click();

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
