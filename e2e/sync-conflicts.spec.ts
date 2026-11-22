import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { expect, test } from './fixtures';
import { listPages } from './support/api';
import { E2E_VAULT } from './support/env';

/**
 * D43 / spec/sync-conflicts (#3jkf2gf6): a sync tool's conflict copy shows as
 * a badge and a banner on its page, never in the tree; Compare shows what
 * differs; Keep page / Keep copy / Keep both resolve it, each undoable; a copy
 * opened directly is read-only; the Conflicts list and Cmd+K lead there.
 */

const SYNCTHING = 'Note.sync-conflict-20261122-143005-ABCDEFG';
const DROPBOX = "Note (Ann's conflicted copy 2026-11-22)";

const exists = (file: string) =>
  access(path.join(E2E_VAULT, file)).then(
    () => true,
    () => false,
  );

/** Drop files in as a sync tool would, and wait until the server has seen them. */
async function syncIn(request: APIRequestContext, files: Record<string, string>) {
  for (const [file, body] of Object.entries(files)) await writeFile(path.join(E2E_VAULT, file), body, 'utf8');
  const ids = Object.keys(files).map((file) => file.replace(/\.md$/, ''));
  await expect
    .poll(async () => {
      const pages = await listPages(request);
      return ids.every((id) => pages.some((page) => page.id === id));
    }, { timeout: 10_000 })
    .toBe(true);
}

test('badge and banner on the page, not in the tree; Compare; Keep page, then Undo', async ({ page, vault, request }) => {
  const [note] = await vault.seed([{ title: 'Note', content: 'Mine.' }]);
  await syncIn(request, { [`${SYNCTHING}.md`]: 'Theirs.\n' });
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);

  await expect(page.getByTestId('page-item-Note')).toBeVisible();
  await expect(page.getByTestId(`page-item-${SYNCTHING}`)).toHaveCount(0);
  await expect(page.getByTestId('conflict-badge-Note')).toHaveAttribute('aria-label', '1 conflicting copy');
  await expect(page.getByTestId('sidebar-conflicts-count')).toHaveText('1');

  const banner = page.getByTestId('conflict-banner');
  await expect(banner).toContainText('This page has a conflicting copy from ABCDEFG');
  await banner.getByTestId('conflict-banner-compare').click();
  const dialog = page.getByTestId('conflict-compare');
  await expect(dialog.locator('[data-op="add"]')).toContainText('Theirs.');
  await expect(dialog.locator('[data-op="remove"]').filter({ hasText: 'Mine.' })).toHaveCount(1);

  await dialog.getByTestId('conflict-keep-page').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('undo-toast')).toContainText('Kept the page. The copy is in the Trash.');
  await expect.poll(() => exists(`${SYNCTHING}.md`)).toBe(false);
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId('sidebar-conflicts')).toHaveCount(0);

  await page.getByTestId('undo-delete').click();
  await expect.poll(() => exists(`${SYNCTHING}.md`)).toBe(true);
  expect(await readFile(path.join(E2E_VAULT, `${SYNCTHING}.md`), 'utf8')).toBe('Theirs.\n');
  await expect(page.getByTestId('conflict-banner')).toBeVisible();
});

test('the Conflicts list: Keep copy writes the copy byte-exact; Keep both renames it', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Note', content: 'Mine.' }]);
  const theirs = '---\ntags: [x]   # theirs\r\n---\r\nTheir text.\r\n';
  await syncIn(request, { [`${SYNCTHING}.md`]: theirs, [`${DROPBOX}.md`]: 'Ann wrote this.\n' });
  await page.goto('/');
  await page.getByTestId('sidebar-conflicts').click();
  const view = page.getByTestId('conflicts-view');
  await expect(view.getByTestId(`conflict-row-${SYNCTHING}`)).toContainText('Syncthing ABCDEFG');

  await view.getByTestId(`conflict-row-${SYNCTHING}`).getByTestId('conflict-row-keep-copy').click();
  await expect(page.getByTestId('undo-toast')).toContainText("Kept the copy. The page's version is in its history.");
  await expect.poll(() => readFile(path.join(E2E_VAULT, 'Note.md'), 'utf8')).toBe(theirs);
  await expect(view.getByTestId(`conflict-row-${SYNCTHING}`)).toHaveCount(0);

  await view.getByTestId(`conflict-row-${DROPBOX}`).getByTestId('conflict-row-keep-both').click();
  await expect(page.getByTestId('undo-toast')).toContainText('Kept both: the copy is now “Note (copy 2026-11-22)”.');
  await expect.poll(() => exists('Note (copy 2026-11-22).md')).toBe(true);
  await expect(page.getByTestId('page-item-Note (copy 2026-11-22)')).toBeVisible();
  await expect(view.getByTestId('conflicts-empty')).toBeVisible();
});

test('a copy opened from search is read-only and marked; Keep this copy from there (ru)', async ({ page, vault, request }) => {
  await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
  await vault.seed([{ title: 'Note', content: 'Mine.' }]);
  await syncIn(request, { [`${SYNCTHING}.md`]: 'Their zebraword.\n' });
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('zebraword');
  const hit = page.getByTestId('quick-switcher').getByTestId('search-conflict-label');
  await expect(hit).toHaveText('Конфликтующая копия');
  await hit.click();

  const banner = page.getByTestId('conflict-copy-banner');
  await expect(banner).toContainText('Это конфликтующая копия страницы «Note», созданная Syncthing');
  await expect(page.getByTestId('conflict-copy-page').locator('[contenteditable="true"]')).toHaveCount(0);
  await banner.getByTestId('conflict-copy-keep').click();
  await expect(page.getByTestId('undo-toast')).toContainText('Копия оставлена.');
  await expect.poll(() => readFile(path.join(E2E_VAULT, 'Note.md'), 'utf8')).toBe('Their zebraword.\n');
  await expect(page).toHaveURL(/#\/Note$/);
});

test('Cmd+K → Show conflicts; possible copies sit collapsed, and Not a copy dismisses one', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Plan', content: 'One.\n\nTwo.\n\nThree.' }]);
  const original = await readFile(path.join(E2E_VAULT, 'Plan.md'), 'utf8');
  await syncIn(request, { 'Plan 2.md': original });
  await page.goto('/');
  await page.keyboard.press('ControlOrMeta+k');
  await page.keyboard.type('show conflicts');
  await page.keyboard.press('Enter');
  const possible = page.getByTestId('conflicts-possible');
  await expect(possible).toContainText('Possible copies (1)');
  await possible.locator('summary').click();
  await possible.getByTestId('possible-not-a-copy').click();
  await expect(page.getByTestId('undo-toast')).toContainText('“Plan 2” won\'t be shown as a possible copy again.');
  await expect(page.getByTestId('conflicts-empty')).toBeVisible();
  // A possible copy is a real page: still in the tree.
  await expect(page.getByTestId('page-item-Plan 2')).toBeVisible();
});

test('Settings → Version history shows the four .stignore lines; Gumply writes no .stignore', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('settings-button').click();
  await page.getByTestId('settings-history').click();
  await expect(page.getByTestId('history-sync-line')).toHaveText('.gumply/history\n.gumply/mcp-log.jsonl\n.gumply/conflicts\n.gumply/import');
  expect(await exists('.stignore')).toBe(false);
});

test('a sync burst shows "Syncing changes…" in the sidebar, gone once the vault is quiet', async ({ page, vault }) => {
  await vault.seed([{ title: 'Note', content: 'Mine.' }]);
  await page.goto('/');
  await expect(page.getByTestId('page-item-Note')).toBeVisible();
  // Keep events coming for a few seconds, as a sync tool delivering a folder does.
  const writes = (async () => {
    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: 40 }, (_, i) => writeFile(path.join(E2E_VAULT, `Synced ${round}-${i}.md`), `Note ${i}.\n`, 'utf8')));
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  await expect(page.getByTestId('sidebar-syncing')).toHaveText('Syncing changes…', { timeout: 8000 });
  await writes;
  await expect(page.getByTestId('sidebar-syncing')).toBeEmpty({ timeout: 10_000 });
  await expect(page.getByTestId('page-item-Synced 4-39')).toBeVisible();
});
