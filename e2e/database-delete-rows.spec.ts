import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #959nz9nr (visual QA pass 9, a guard @lead asked for): deleting a database that owns its rows, end to end in the
 * browser. Ticked (the default), the database and its rows go to the Trash as one item, "with its N rows", and
 * Restore brings both back byte for byte. Unticked, only the database goes; the rows stay, as a plain folder the
 * sidebar shows again. `sidebar-actions` covers the dialog's text and the API's single entry; this covers the
 * Trash view, Restore and the unticked path. Invented content.
 */

const FILES: Record<string, string> = {
  'Team.base':
    'gumply:\n  rows: Team\nfilters:\n  and:\n    - file.folder == "Team"\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - role\n',
  'Team/Avery.md': '---\nrole: Cook\n---\nAvery\n',
  'Team/Blake.md': '---\nrole: Pilot\n---\nBlake\n',
  'Team/Casey.md': '---\nrole: Cook\n---\nCasey\n',
  'Notes.md': 'A plain page.\n',
};
const read = (relative: string) => fs.readFile(path.join(E2E_VAULT, relative), 'utf8');
const exists = (relative: string) => fs.access(path.join(E2E_VAULT, relative)).then(() => true, () => false);

async function writeVault(request: APIRequestContext) {
  for (const [relative, content] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(E2E_VAULT, relative)), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, relative), content, 'utf8');
  }
  await expect
    .poll(async () => {
      const listed = new Set((await api.listPages(request)).map((meta) => meta.id));
      return ['Team/Avery', 'Team/Blake', 'Team/Casey', 'Notes'].every((id) => listed.has(id));
    }, { timeout: 10_000 })
    .toBe(true);
}

async function deleteTeam(page: Page, withRows: boolean) {
  await page.goto('/#/Notes');
  await page.getByTestId('editor-content').waitFor();
  // The rows folder is hidden: the database item stands for it.
  await expect(page.getByTestId('page-item-Team.base')).toBeVisible();
  await expect(page.getByTestId('page-item-Team')).toHaveCount(0);
  await page.getByTestId('page-item-Team.base').hover();
  await page.getByTestId('page-menu-button-Team.base').click();
  // #959nz9nr: a database that owns its rows is deleted as a database, not "a database view" (en said so).
  await expect(page.getByTestId('delete-page-Team.base')).toHaveText('Delete database');
  await page.getByTestId('delete-page-Team.base').click();
  const box = page.getByTestId('delete-with-rows');
  await expect(box).toBeChecked();
  if (!withRows) await box.uncheck();
  await page.getByTestId('delete-confirm').click();
  await expect(page.getByTestId('page-item-Team.base')).toHaveCount(0);
  // With its rows, the database went; without them, only its view (the rows stay as a folder).
  await expect(page.getByTestId('undo-toast')).toContainText(withRows ? 'Database deleted' : 'Database view deleted');
}

test('a database deleted with its rows is one Trash item "with its 3 rows", and Restore brings both back as they were', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request);
  await deleteTeam(page, true);
  await expect.poll(() => exists('Team.base')).toBe(false);
  await expect.poll(() => exists('Team')).toBe(false);

  await page.getByTestId('sidebar-trash').click();
  const items = page.locator('li.trash-entry');
  await expect(items).toHaveCount(1);
  const item = items.first();
  await expect(item).toContainText('Team');
  await expect(item.getByTestId('trash-item-rows')).toContainText('with its 3 rows');

  await item.getByTestId('trash-restore').click();
  await expect(page.locator('li.trash-entry')).toHaveCount(0);
  for (const relative of ['Team.base', 'Team/Avery.md', 'Team/Blake.md', 'Team/Casey.md']) {
    await expect.poll(() => read(relative).catch(() => null), { message: relative }).toBe(FILES[relative]);
  }
  // Owned again: the database item is back, its folder hidden.
  await expect(page.getByTestId('page-item-Team.base')).toBeVisible();
  await expect(page.getByTestId('page-item-Team')).toHaveCount(0);
});

test('unticked, only the database goes: its rows stay, as a plain folder the sidebar shows', async ({ page, request, vault }) => {
  void vault;
  await writeVault(request);
  await deleteTeam(page, false);
  await expect.poll(() => exists('Team.base')).toBe(false);
  for (const relative of ['Team/Avery.md', 'Team/Blake.md', 'Team/Casey.md']) expect(await read(relative), relative).toBe(FILES[relative]);
  // No database owns the folder any more, so it shows, with its notes.
  await expect(page.getByTestId('page-item-Team')).toBeVisible();
  await page.getByTestId('sidebar-trash').click();
  const items = page.locator('li.trash-entry');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Team');
  await expect(items.first().getByTestId('trash-item-rows')).toHaveCount(0);
});
