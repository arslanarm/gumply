import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * D41 / spec/version-history (#d2jc9a9m): ⋯ → History… and Cmd+K open the
 * panel; a version previews, shows its changes, restores byte-exact without
 * renaming, and the restore can be undone; outside edits are labelled;
 * Settings shows the Syncthing line and never writes `.stignore`.
 */

const pageText = async (request: APIRequestContext, id: string) =>
  (await (await request.get(`${API_URL}/api/pages/${encodeURIComponent(id)}`)).json()).content as string;

async function openHistoryFromMenu(page: Page, id: string) {
  if (!(await page.getByTestId(`page-item-${id}`).isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId(`page-item-${id}`).hover();
  await page.getByTestId(`page-menu-button-${id}`).click();
  await page.getByTestId(`page-history-${id}`).click();
  await expect(page.getByTestId('history-dialog')).toBeVisible();
}

test('History…: preview, changes, restore without renaming, then undo it', async ({ page, vault, request }) => {
  const [note] = await vault.seed([{ title: 'Ledger', content: 'First line.' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Ledger');
  const original = await readFile(path.join(E2E_VAULT, 'Ledger.md'));

  await page.getByTestId('editor-content').getByText('First line.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Second thought.');
  await expect.poll(() => pageText(request, note!.id), { timeout: 10_000 }).toBe('First line. Second thought.');
  const edited = await readFile(path.join(E2E_VAULT, 'Ledger.md'));

  await openHistoryFromMenu(page, note!.id);
  const dialog = page.getByTestId('history-dialog');
  const versions = dialog.getByTestId('history-item');
  await expect(versions).toHaveCount(1);
  await expect(versions.first()).toContainText('You');

  // Keyboard: the list is a listbox; ArrowDown selects the version under "Current version".
  await dialog.getByTestId('history-list').focus();
  await page.keyboard.press('ArrowDown');
  await expect(versions.first()).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByTestId('history-preview').getByText('First line.', { exact: true })).toBeVisible();

  await dialog.getByTestId('history-view-changes').click();
  const diff = dialog.getByTestId('history-diff');
  // The whole file is compared (the frontmatter's `updated:` line changes too); the body line:
  await expect(diff.getByLabel('Removed: First line.', { exact: true })).toBeVisible();
  await expect(diff.getByLabel('Added: First line. Second thought.', { exact: true })).toBeVisible();

  await dialog.getByTestId('history-restore').click();
  await expect(dialog.getByTestId('history-status')).toContainText('Undo is at the top of the list');
  // Byte-exact into the same file, which keeps its name.
  await expect.poll(async () => (await readFile(path.join(E2E_VAULT, 'Ledger.md'))).equals(original)).toBe(true);
  await expect(page.getByTestId('editor-content')).toHaveText('First line.');

  // Undo: the "Before restore" entry puts the edited bytes back.
  const before = versions.filter({ hasText: 'Before restore' });
  await before.click();
  await dialog.getByTestId('history-restore').click();
  await expect.poll(async () => (await readFile(path.join(E2E_VAULT, 'Ledger.md'))).equals(edited)).toBe(true);
  await dialog.getByTestId('history-close').click();
  await expect(page.getByTestId('editor-content')).toHaveText('First line. Second thought.');
});

test('Cmd+K → Show page history; an outside edit is labelled, and Keep pins it (ru)', async ({ page, vault }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  const [note] = await vault.seed([{ title: 'Journal', content: 'Mine.' }]);
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  await expectPageTitle(page, 'Journal');
  // Another program changes the file.
  const file = path.join(E2E_VAULT, 'Journal.md');
  await writeFile(file, (await readFile(file, 'utf8')).replace('Mine.', 'Theirs.'));
  await expect(page.getByTestId('editor-content')).toHaveText('Theirs.', { timeout: 10_000 });

  await page.keyboard.press('Control+k');
  await page.getByTestId('quick-switcher-input').fill('история');
  await page.getByRole('option', { name: 'Показать историю страницы' }).click();
  const dialog = page.getByTestId('history-dialog');
  await expect(dialog.getByRole('heading')).toContainText('История версий');
  const outside = dialog.getByTestId('history-item').filter({ hasText: 'Изменено вне Gumply' });
  await expect(outside).toHaveCount(1);
  await outside.click();
  await dialog.getByTestId('history-keep').click();
  await expect(dialog.getByTestId('history-keep')).toHaveAttribute('aria-pressed', 'true');
  await expect(outside.getByLabel('Сохранена')).toBeVisible();
});

test('Settings → Version history: the Syncthing line, and .stignore is never written', async ({ page, vault }) => {
  await vault.seed([{ title: 'Anything', content: 'Text.' }]);
  await page.goto('/');
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-history').click();
  const dialog = page.getByTestId('history-settings');
  await expect(dialog.getByTestId('history-usage')).toContainText('Version history uses');
  await expect(dialog.getByTestId('history-sync-line')).toHaveText('.gumply/history');
  await expect(dialog.getByTestId('history-copy-line')).toHaveText('Copy line');
  await expect(stat(path.join(E2E_VAULT, '.stignore'))).rejects.toThrow();
});
