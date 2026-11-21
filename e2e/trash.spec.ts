import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, api } from './fixtures';
import { E2E_VAULT } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * v0.6 C (#ppag3ugh): the Trash view. Delete → Trash → Restore, a read-only
 * trashed page, restore collisions, Delete forever and Empty trash.
 */
test.describe('trash', () => {
  test('delete → trash → restore, with sub-pages and a read-only trashed page', async ({ page, vault }) => {
    const [projects] = await vault.seed([{ title: 'Projects' }]);
    const [plan] = await vault.seed([{ title: 'Plan', parentId: projects.id, content: 'The plan body with **bold** text.' }]);
    await vault.seed([{ title: 'Week 1', parentId: plan.id }]);

    await page.goto(`/#/${plan.id}`);
    await expectPageTitle(page, 'Plan');
    // An empty trash shows no count.
    await expect(page.getByTestId('sidebar-trash')).toBeVisible();
    await expect(page.getByTestId('sidebar-trash-count')).toHaveCount(0);

    await page.getByTestId('delete-page-button-page').click();
    await page.getByTestId('delete-confirm').click();
    await expect(page.getByTestId(`page-item-${plan.id}`)).toHaveCount(0);
    await expect(page.getByTestId('sidebar-trash-count')).toHaveText('2');

    // The trash lists it under where it was, with its sub-page below it.
    await page.getByTestId('sidebar-trash').click();
    await expect(page).toHaveURL(/#trash$/);
    const entry = page.getByTestId('trash-item-Plan');
    await expect(entry).toContainText('in Projects');
    await expect(entry).toContainText('deleted just now');
    await expect(page.getByTestId('trash-child-Week 1')).toBeVisible();

    // Search by title (a sub-page's title finds its entry).
    await page.getByTestId('trash-search').fill('week');
    await expect(entry).toBeVisible();
    await page.getByTestId('trash-search').fill('nothing like this');
    await expect(page.getByTestId('trash-no-match')).toBeVisible();
    await page.getByTestId('trash-search').fill('');

    // Opening it shows the page read-only, with a Restore banner.
    await entry.getByRole('button', { name: /Plan/ }).first().click();
    await expect(page.getByTestId('trashed-banner')).toContainText('This page is in the trash.');
    await expect(page.getByTestId('trashed-title')).toHaveText('Plan');
    const body = page.getByTestId('trashed-page').locator('.ProseMirror');
    await expect(body).toContainText('The plan body with bold text.');
    await expect(body).toHaveAttribute('contenteditable', 'false');
    await body.click();
    await page.keyboard.type('typed into the trash');
    await expect(body).not.toContainText('typed into the trash');
    // No formatting on a trashed page: no selection toolbar, and a right-click
    // gets the browser's own menu, not the editor's (#bg3cb83t).
    await body.getByText('bold').dblclick();
    await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);
    await body.getByText('bold').click({ button: 'right' });
    await expect(page.getByTestId('editor-context-menu')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Restore: back where it was, with the sub-page, and opened.
    await page.getByTestId('trashed-restore').click();
    await expectPageTitle(page, 'Plan');
    await expect(page.getByTestId('undo-toast')).toContainText('Restored “Plan”.');

    await expect(page.getByTestId(`page-item-${plan.id}`)).toBeVisible();
    expect((await vault.pages()).map((meta) => meta.id).sort()).toEqual([
      'Projects',
      'Projects/Plan',
      'Projects/Plan/Week 1',
    ]);
    await expect(page.getByTestId('sidebar-trash-count')).toHaveCount(0);
    const restored = await api.getPage(page.request, plan.id);
    expect(restored.content).toBe('The plan body with **bold** text.');
  });

  test('restore goes to the top level when its folder page is gone, and adds 2 to a taken name', async ({
    page,
    vault,
    request,
  }) => {
    const [a] = await vault.seed([{ title: 'Area' }]);
    const [notes] = await vault.seed([{ title: 'Notes', parentId: a.id }]);
    await api.deletePage(request, notes.id);
    await api.deletePage(request, a.id);
    await vault.seed([{ title: 'Notes' }]);

    await page.goto('/#trash');
    const entry = page.getByTestId('trash-item-Notes');
    await expect(entry).toContainText('in Area (no longer there)');
    await entry.hover();
    await entry.getByTestId('trash-restore').click();

    const toast = page.getByTestId('undo-toast');
    await expect(toast).toContainText(
      'Restored “Notes” to the top level as “Notes 2”: “Area” is no longer there and that name was taken.',
    );
    // Two rows you can tell apart (D20): the restored page is titled by its new name.
    await expect(page.getByTestId('page-item-Notes 2')).toContainText('Notes 2');
    await expect(page.getByTestId('page-item-Notes')).toContainText('Notes');
    // The toast stays readable (it isn't cut short by an earlier toast's timer).
    await page.waitForTimeout(5_000);
    await expect(toast).toBeVisible();
    await expect(entry).toHaveCount(0);
    await expect(page.getByTestId('trash-item-Area')).toBeVisible();
  });

  test('Delete forever and Empty trash ask first, then delete for good', async ({ page, vault, request }) => {
    const created = await vault.seed([{ title: 'Xray' }, { title: 'Yankee' }, { title: 'Zulu' }]);
    for (const item of created) await api.deletePage(request, item.id);

    await page.goto('/#trash');
    const xray = page.getByTestId('trash-item-Xray');
    await xray.hover();
    await xray.getByTestId('trash-delete-forever').click();
    const dialog = page.getByTestId('trash-confirm-dialog');
    await expect(dialog).toContainText('Delete “Xray” forever?');
    await expect(dialog).toContainText("You can't undo this.");
    await expect(page.getByTestId('trash-confirm-dialog-cancel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(xray).toBeVisible();

    await xray.hover();
    await xray.getByTestId('trash-delete-forever').click();
    await page.getByTestId('trash-confirm-dialog-confirm').click();
    await expect(xray).toHaveCount(0);
    await expect(page.getByTestId('undo-toast')).toContainText('Deleted “Xray” forever');
    await expect(page.getByTestId('sidebar-trash-count')).toHaveText('2');
    expect((await api.listTrash(request)).map((item) => item.title).sort()).toEqual(['Yankee', 'Zulu']);

    await page.getByTestId('trash-empty').click();
    await expect(dialog).toContainText('Empty the trash?');
    await expect(dialog).toContainText('This deletes 2 pages and whiteboards from your vault for good.');
    await page.getByTestId('trash-confirm-dialog-confirm').click();
    await expect(page.getByTestId('trash-empty-state')).toBeVisible();
    await expect(page.getByTestId('trash-empty')).toBeDisabled();
    await expect(page.getByTestId('sidebar-trash-count')).toHaveCount(0);
    expect(await api.listTrash(request)).toEqual([]);
    // Nothing came back as a page.
    expect(await vault.pages()).toEqual([]);
  });
});

test('a deleted plain folder (D33) is listed, opens as an overview and restores with its files', async ({ page, vault, request }) => {
  await vault.seed([{ title: 'Anchor' }]);
  // What deleting the plain folder "Work" writes to the trash (#mf397jyx).
  const entry = path.join(E2E_VAULT, '.trash', 'e2efolder');
  mkdirSync(path.join(entry, 'Work'), { recursive: true });
  writeFileSync(path.join(entry, 'Work', 'Plan.md'), 'The plan body\n');
  writeFileSync(path.join(entry, 'Work', 'report.pdf'), '%PDF');
  writeFileSync(
    path.join(entry, 'meta.json'),
    JSON.stringify({ id: 'Work', kind: 'folder', file: 'Work', deleted: ['Work', 'Work/Plan'], deletedAt: new Date().toISOString() }),
  );

  await page.goto('/#trash');
  const row = page.getByTestId('trash-item-Work');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /Work/ }).first().click();
  await expect(page.getByTestId('trashed-banner')).toContainText('This folder is in the trash.');
  await expect(page.getByTestId('trashed-folder-files')).toContainText('1 other file');
  await page.getByTestId('trashed-page').getByRole('button', { name: 'Plan' }).click();
  await expect(page.getByTestId('trashed-page').locator('.ProseMirror')).toContainText('The plan body');

  await page.getByTestId('trashed-restore').click();
  await expectPageTitle(page, 'Plan');
  expect(readFileSync(path.join(E2E_VAULT, 'Work', 'report.pdf'), 'utf8')).toBe('%PDF');
  expect(await api.listTrash(request)).toEqual([]);
});

test('a toast that replaces another gets its own 8 s (restore right after a delete)', async ({ page, vault }) => {
  const [seeded] = await vault.seed([{ title: 'Quick' }, { title: 'Other' }]);
  await page.goto(`/#/${seeded.id}`);
  await expectPageTitle(page, 'Quick');
  await page.getByTestId('delete-page-button-page').click();
  await expect(page.getByTestId('undo-toast')).toContainText('Page deleted');
  await page.getByTestId('sidebar-trash').click();
  const entry = page.getByTestId('trash-item-Quick');
  await entry.locator('.trash-row').hover();
  await entry.getByTestId('trash-restore').click();
  const toast = page.getByTestId('undo-toast');
  await expect(toast).toContainText('Restored “Quick”.');
  // Past the delete toast's own 8 s, which a reused timer used to end this one at.
  await page.waitForTimeout(7_000);
  await expect(toast).toContainText('Restored “Quick”.');
});
