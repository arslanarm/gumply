import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { deletePage, listPages, listTrash, restoreTrash } from './support/api';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #zggrmydn / #zsk48sie: a sync tool (Syncthing, Yandex Disk, OneDrive) acting
 * on the vault folder as a second device, while the app edits it. Nothing typed
 * or saved is lost (D22), an old name never comes back as a ghost, the Trash
 * never resurrects or destroys a live file, a conflict copy is never written
 * (D37, D43), and a rename the tool replays as a delete and a create is followed
 * even when the two land in separate refreshes (#zsk48sie).
 *
 * The second device is plain file operations on the vault; every name is invented.
 */

test.describe.configure({ timeout: 60_000 });

const file = (name: string) => path.join(E2E_VAULT, name);
const read = (name: string) => readFile(file(name), 'utf8').catch(() => null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mdFiles = async () => (await readdir(E2E_VAULT)).filter((name) => name.endsWith('.md')).sort();

async function waitForIds(request: APIRequestContext, predicate: (ids: string[]) => boolean) {
  await expect.poll(async () => predicate((await listPages(request)).map((page) => page.id)), { timeout: 10_000 }).toBe(true);
}

type HistoryItem = { file: string; source?: string; reason?: string };
const historyOf = async (request: APIRequestContext, id: string): Promise<HistoryItem[]> => {
  const res = await request.get(`${API_URL}/api/history/${encodeURIComponent(id)}`);
  return res.ok() ? ((await res.json()) as { items: HistoryItem[] }).items : [];
};

async function openAndType(page: Page, id: string, anchor: string, text: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await page.getByTestId('editor-content').getByText(anchor, { exact: false }).first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('a page deleted in the app, then uploaded again by the tool: it shows; Restore keeps both; Delete forever leaves the live file', async ({ page, vault, request }) => {
  const [garden] = await vault.seed([{ title: 'Garden plan', content: 'Version one of the beds.' }, { title: 'Home', content: 'Hi' }]);
  const original = (await read('Garden plan.md'))!;
  await page.goto('/#/Home');
  const deleted = await deletePage(request, garden!.id);
  await waitForIds(request, (ids) => !ids.includes('Garden plan'));
  // The other device never got the delete: it uploads its copy again, with an edit.
  await writeFile(file('Garden plan.md'), original.replace('Version one', 'Version two (other device)'), 'utf8');
  await waitForIds(request, (ids) => ids.includes('Garden plan'));
  await expect(page.getByTestId('page-item-Garden plan')).toBeVisible({ timeout: 10_000 });

  const restored = await restoreTrash(request, deleted!.trashId);
  expect(restored.renamed).toBe(true);
  expect(await read('Garden plan.md')).toContain('Version two (other device)');
  expect(await read(`${restored.id}.md`)).toContain('Version one of the beds.');

  for (const entry of await listTrash(request)) await request.delete(`${API_URL}/api/trash/${encodeURIComponent(entry.trashId)}`);
  expect(await read('Garden plan.md')).toContain('Version two (other device)');
});

test('the open page deleted in the app, then re-created by the tool: nothing stale is saved over it', async ({ page, vault, request }) => {
  const [field] = await vault.seed([{ title: 'Field notes', content: 'Saved field text.' }, { title: 'Home', content: 'Hi' }]);
  await openAndType(page, field!.id, 'Saved field text.', ' Typed before delete.');
  await expect.poll(() => read('Field notes.md')).toContain('Typed before delete.');
  const before = (await read('Field notes.md'))!;
  await page.getByTestId('delete-page-button-page').click();
  await page.getByTestId('delete-confirm').click({ timeout: 2000 }).catch(() => undefined);
  await waitForIds(request, (ids) => !ids.includes('Field notes'));
  await writeFile(file('Field notes.md'), before.replace('Saved field text.', 'Other device text.'), 'utf8');
  await waitForIds(request, (ids) => ids.includes('Field notes'));
  // Two disk polls later the tool's file is still what it wrote.
  await sleep(4500);
  expect(await read('Field notes.md')).toContain('Other device text.');
});

for (const order of [
  { name: 'create and delete in one refresh', createFirst: true, gap: 0 },
  { name: 'create, then delete 1.5 s later', createFirst: true, gap: 1500 },
  { name: 'delete, then create 1.5 s later', createFirst: false, gap: 1500 },
] as const) {
  test(`a rename the tool replays as delete + create (${order.name}) while typing: the editor follows, the typing lands in the new file, history follows, no old name (#zsk48sie)`, async ({ page, vault, request }) => {
    const [plan] = await vault.seed([{ title: 'Trip plan', content: 'Day one: the coast.' }, { title: 'Home', content: 'Hi' }]);
    await openAndType(page, plan!.id, 'Day one', ' Saved first.');
    await expect.poll(() => read('Trip plan.md')).toContain('Saved first.');
    const bytes = (await read('Trip plan.md'))!;
    const versions = (await historyOf(request, plan!.id)).length;
    expect(versions).toBeGreaterThan(0);

    const typing = (async () => {
      for (const word of [' one', ' two', ' three', ' four', ' five', ' six']) {
        await page.keyboard.type(word, { delay: 30 });
        await sleep(400);
      }
    })();
    const create = () => writeFile(file('Trip plan 2026.md'), bytes, 'utf8');
    const remove = () => rm(file('Trip plan.md'), { force: true });
    if (order.createFirst) {
      await create();
      await sleep(order.gap);
      await remove();
    } else {
      await remove();
      await sleep(order.gap);
      await create();
    }
    await typing;

    await expect(page).toHaveURL(/#\/Trip%20plan%202026$/, { timeout: 10_000 });
    await expect.poll(() => read('Trip plan 2026.md'), { timeout: 10_000 }).toContain('Saved first. one two three four five six');
    await expect(page.getByTestId('deleted-on-disk-banner')).toHaveCount(0);
    expect(await mdFiles()).toEqual(['Home.md', 'Trip plan 2026.md']);
    expect((await historyOf(request, 'Trip plan 2026')).length).toBeGreaterThanOrEqual(versions);
  });
}

for (const tool of [
  { name: 'Syncthing', copy: 'Soup recipe.sync-conflict-20261126-101500-ABCDEFG.md', atomic: true },
  { name: 'Yandex Disk', copy: 'Soup recipe (копия с компьютера WORKBOX).md', atomic: false },
] as const) {
  test(`${tool.name}: a conflict copy arrives mid-edit and the page is replaced by the other side: the copy is never written, both sides are kept, the typing waits under a conflict`, async ({ page, vault, request }) => {
    const [recipe] = await vault.seed([{ title: 'Soup recipe', content: 'Base: onions.' }, { title: 'Home', content: 'Hi' }]);
    await openAndType(page, recipe!.id, 'Base: onions.', ' Mine A.');
    await expect.poll(() => read('Soup recipe.md')).toContain('Mine A.');
    const mine = (await read('Soup recipe.md'))!;
    const theirs = mine.replace('Base: onions. Mine A.', 'Base: onions. Theirs B.');
    const typing = (async () => {
      for (const word of [' k1', ' k2', ' k3', ' k4', ' k5']) {
        await page.keyboard.type(word, { delay: 30 });
        await sleep(300);
      }
    })();
    await sleep(500);
    await writeFile(file(tool.copy), mine, 'utf8');
    if (tool.atomic) {
      await writeFile(file('.syncthing.Soup recipe.md.tmp'), theirs, 'utf8');
      await rename(file('.syncthing.Soup recipe.md.tmp'), file('Soup recipe.md'));
    } else await writeFile(file('Soup recipe.md'), theirs, 'utf8');
    await typing;

    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict', { timeout: 10_000 });
    await expect(page.getByTestId('editor-content')).toContainText('k1 k2 k3 k4 k5');
    expect(await read('Soup recipe.md')).toContain('Theirs B.');
    expect(await read(tool.copy), 'D37: the copy is never written').toBe(mine);
    expect((await historyOf(request, 'Soup recipe')).some((item) => item.source === 'external')).toBe(true);
  });
}

test('a file replaced while open: a clean editor reloads it; a dirty one gets a conflict, never a silent overwrite', async ({ page, vault }) => {
  const [diary] = await vault.seed([{ title: 'Diary', content: 'Monday.' }, { title: 'Home', content: 'Hi' }]);
  await page.goto(`/#/${encodeURIComponent(diary!.id)}`);
  await expect(page.getByTestId('editor-content')).toContainText('Monday.');
  const v1 = (await read('Diary.md'))!;
  // Replaced by a rename over the file (a temp file in the same folder first).
  await writeFile(file('Diary.md.tmp-sync'), v1.replace('Monday.', 'Monday. Tuesday (outside).'), 'utf8');
  await rename(file('Diary.md.tmp-sync'), file('Diary.md'));
  await expect(page.getByTestId('editor-content')).toContainText('Tuesday (outside).', { timeout: 10_000 });

  await page.getByTestId('editor-content').getByText('Tuesday', { exact: false }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Mine W.');
  await writeFile(file('Diary.md'), v1.replace('Monday.', 'Monday. Tuesday (outside). Wednesday (outside).'), 'utf8');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict', { timeout: 10_000 });
  expect(await read('Diary.md')).toContain('Wednesday (outside).');
  await expect(page.getByTestId('editor-content')).toContainText('Mine W.');
});

test("sync tools' temp and partial files never become pages", async ({ vault, request }) => {
  await vault.seed([{ title: 'Reading log', content: 'Line A.' }]);
  const temps = [
    '.syncthing.Reading log.md.tmp', // Syncthing
    '~syncthing~Reading log.md.tmp', // Syncthing on Windows
    'Reading log.md.part', // Nextcloud
    'Reading log.md.ocTransferId123.part', // Nextcloud
    '.~lock.Reading log.md#', // LibreOffice beside a synced file
    'Reading log.md.yandex_tmp',
    'Reading log.md~RF1a2b3c.TMP', // Office / OneDrive
  ];
  for (const name of temps) await writeFile(file(name), '# temp\n\nPartial', 'utf8');
  try {
    // Give the watcher time to (not) pick them up.
    await sleep(2500);
    expect((await listPages(request)).map((meta) => meta.id).filter((id) => id.toLowerCase().includes('reading log'))).toEqual(['Reading log']);
  } finally {
    for (const name of temps) await rm(file(name), { force: true });
  }
});
