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
  // The page's own editor (the panel's preview is a read-only editor too).
  await expect(page.getByTestId('editor').getByTestId('editor-content')).toHaveText('First line.');

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
  // D43: the lines each device keeps for itself.
  await expect(dialog.getByTestId('history-sync-line')).toHaveText('.gumply/history\n.gumply/mcp-log.jsonl\n.gumply/conflicts\n.gumply/import');
  await expect(dialog.getByTestId('history-copy-line')).toHaveText('Copy lines');
  await expect(stat(path.join(E2E_VAULT, '.stignore'))).rejects.toThrow();
});

/** `YYYYMMDDTHHMMSSmmmZ`, as the history store names version files. */
const stampOf = (date: Date) => date.toISOString().replace(/[-:.]/g, '');

test('a page that comes back outside Gumply: the older versions sit under "From an earlier page with this name"', async ({ page, vault, request }) => {
  const [note] = await vault.seed([{ title: 'Draft', content: 'Old draft.' }]);
  await request.put(`${API_URL}/api/pages/${encodeURIComponent(note!.id)}`, { data: { content: 'Old draft, edited.' } });
  const file = path.join(E2E_VAULT, 'Draft.md');
  const { rm } = await import('node:fs/promises');
  await rm(file);
  await expect.poll(async () => (await (await request.get(`${API_URL}/api/pages`)).json()).some((meta: { id: string }) => meta.id === 'Draft'), { timeout: 10_000 }).toBe(false);
  await writeFile(file, 'A different page with the same name.\n');
  await expect.poll(async () => (await (await request.get(`${API_URL}/api/pages`)).json()).some((meta: { id: string }) => meta.id === 'Draft'), { timeout: 10_000 }).toBe(true);

  await page.goto('/#/Draft');
  await expectPageTitle(page, 'Draft');
  await openHistoryFromMenu(page, 'Draft');
  const divider = page.getByTestId('history-dialog').getByTestId('history-earlier-page');
  await expect(divider).toHaveText('From an earlier page with this name');
  // The divider sits above the earlier page's version.
  await expect(page.getByTestId('history-dialog').locator('[data-testid="history-earlier-page"] + [data-testid="history-item"]')).toHaveCount(1);
});

test('Settings → AI apps: Undo on an AI app\'s write restores the bytes it saved before writing', async ({ page, vault }) => {
  const [note] = await vault.seed([{ title: 'Brief', content: 'Rewritten by the AI app.' }]);
  // What an MCP write leaves: the version it replaced (source mcp, version = the row's `before`) and its audit row.
  const at = new Date(Date.now() - 60_000);
  const before = '2026-11-01T10:00:00.000Z';
  const bytes = 'Written by me, before the AI app.\n';
  const dir = path.join(E2E_VAULT, '.gumply', 'history', 'Brief');
  const { mkdir } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  await mkdir(dir, { recursive: true });
  const fileName = `${stampOf(at)}.md`;
  await writeFile(path.join(dir, fileName), bytes);
  const entry = { file: fileName, at: at.toISOString(), id: 'Brief', version: before, source: 'mcp', tool: 'update_page', client: 'Claude Code', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(path.join(dir, 'index.jsonl'), `${JSON.stringify(entry)}\n`);
  const row = { at: new Date(at.getTime() + 10).toISOString(), tool: 'update_page', id: note!.id, before, after: note!.updated, client: 'Claude Code' };
  const log = path.join(E2E_VAULT, '.gumply', 'mcp-log.jsonl');
  await writeFile(log, `${JSON.stringify(row)}\n`);
  // The vault reset doesn't clear the audit log: other specs expect it empty.
  const { rm } = await import('node:fs/promises');
  try {
    await undoFromSettings(page, note!.id, bytes);
  } finally {
    await rm(log, { force: true });
  }
});

async function undoFromSettings(page: Page, id: string, bytes: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expectPageTitle(page, 'Brief');
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-mcp').click();
  await page.getByTestId('mcp-recent-undo').click();
  await expect(page.getByTestId('mcp-undo-status')).toContainText('is back to the version before this change');
  await expect.poll(() => readFile(path.join(E2E_VAULT, 'Brief.md'), 'utf8')).toBe(bytes);
  await page.getByTestId('mcp-close').click();
  await expect(page.getByTestId('editor-content')).toHaveText('Written by me, before the AI app.');
}

test('a board\'s history: Preview draws the version; Changes marks cards added, removed and changed (#fr5baurg)', async ({ page, request }) => {
  const created = await request.post(`${API_URL}/api/boards`, { data: { title: 'Plan board' } });
  expect(created.status()).toBe(201);
  const id = ((await created.json()) as { meta: { id: string } }).meta.id;
  const card = (cardId: string, text: string, x: number) => ({ id: cardId, type: 'text', text, x, y: 0, width: 200, height: 80 });
  const put = (nodes: unknown[]) => request.put(`${API_URL}/api/boards/${encodeURIComponent(id)}`, { data: { board: { nodes, edges: [] } } });
  expect((await put([card('a', 'Keep me', 0), card('b', 'Remove me', 260), card('c', 'Old words', 520)])).ok()).toBe(true);
  // Closing the board ends the session: that board becomes a version (the next save is coalesced).
  expect((await request.post(`${API_URL}/api/history/${encodeURIComponent(id)}/checkpoint`)).ok()).toBe(true);
  expect((await put([card('a', 'Keep me', 0), card('c', 'New words', 520), card('d', 'Added later', 780)])).ok()).toBe(true);

  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('board-page')).toBeVisible();
  await openHistoryFromMenu(page, id);
  const dialog = page.getByTestId('history-dialog');
  // Opening the board added no version (no "End of editing" equal to now, even under StrictMode in dev):
  // the empty board before the first save, and the three cards kept when the session ended.
  await expect(dialog.getByTestId('history-item')).toHaveCount(2);
  // The version with the three earlier cards (by its content, not its row position).
  await pickVersionWith(dialog, 'Remove me');
  const preview = dialog.getByTestId('history-board-preview').getByTestId('board-preview');
  await expect(preview).toHaveAttribute('data-nodes', '3');
  await expect(preview).toContainText('Remove me');

  await dialog.getByTestId('history-view-changes').click();
  const changes = dialog.getByTestId('history-board-changes');
  await expect(changes.locator('.react-flow__node.board-diff-added')).toHaveCount(1);
  await expect(changes.locator('.react-flow__node.board-diff-removed')).toHaveCount(1);
  await expect(changes.locator('.react-flow__node.board-diff-changed')).toHaveCount(1);
  const list = changes.getByTestId('history-board-list');
  await expect(list.locator('li')).toHaveText(['+Added: Added later', '−Removed: Remove me', '~Changed: New words']);

  // Restore stays byte-exact: the board file gets the version's bytes back.
  await dialog.getByTestId('history-restore').click();
  await expect(dialog.getByTestId('history-status')).toContainText('Undo is at the top of the list');
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/boards/${encodeURIComponent(id)}`)).json()) as { board: { nodes: Array<{ id: string }> } }).board.nodes.map((node) => node.id))
    .toEqual(['a', 'b', 'c']);
});

/** Select the newest version whose preview shows `text` (it differs from now, so Restore is enabled). */
async function pickVersionWith(dialog: ReturnType<Page['getByTestId']>, text: string) {
  const items = dialog.getByTestId('history-item');
  await expect(items.first()).toBeVisible();
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    await items.nth(index).click();
    const preview = dialog.getByTestId('history-preview');
    // A real wait: `isVisible()` ignores its timeout and answers at once, so under load
    // the right version (still drawing its cards) was skipped for the next one.
    try {
      await expect(preview.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 10_000 });
      return;
    } catch {
      // Not this version: try the next one.
    }
  }
  throw new Error(`no version shows "${text}"`);
}
