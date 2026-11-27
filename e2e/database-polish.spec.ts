import fs from 'node:fs/promises';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #bg7c9bzk C (the database hunt #faqr8pj9's P3/P4 polish), at 1280×800 as in the hunt. Invented content.
 * - #7: a Select column's menu fits whole, "Delete from all rows" included, with no scroll inside it.
 * - #11: the paste preview's name and type controls sit over their own columns and stay inside the dialog.
 * - #14: each row's rename button is named after its row.
 * - #15: the Trash intro mentions databases and their rows.
 * - #18: ru: the Select picker's placeholder isn't cut off.
 * (#17's colour order is in core's and the server's unit tests.)
 */

const BASE =
  'gumply:\n  rows: Plants\nfilters:\n  and:\n    - file.folder == "Plants"\nproperties:\n  note.light:\n    gumplyType: select\n    gumplyOptions:\n      - value: Sun\n        color: blue\n      - value: Shade\n        color: orange\nviews:\n  - type: table\n    name: Table\n    order:\n      - file.name\n      - light\n';

async function plants(page: Page, request: APIRequestContext, language = 'en') {
  await fs.mkdir(path.join(E2E_VAULT, 'Plants'), { recursive: true });
  await fs.writeFile(path.join(E2E_VAULT, 'Plants.base'), BASE, 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'Plants', 'Aloe.md'), '---\nlight: Sun\n---\nAloe\n', 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'Plants', 'Fern.md'), '---\nlight: Shade\n---\nFern\n', 'utf8');
  await expect.poll(async () => (await api.listPages(request)).filter((meta) => meta.id.startsWith('Plants/')).length, { timeout: 10_000 }).toBe(2);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript((value) => window.localStorage.setItem('gumply:language', value), language);
  await page.goto('/');
  await page.getByTestId('page-item-Plants.base').click();
  await expect(page.getByTestId('base-table').locator('.base-title-text')).toHaveText(['Aloe', 'Fern']);
}

test('#7: a Select column\'s menu fits at 800 px, "Delete from all rows" included, with no scroll inside', async ({ page, request, vault }) => {
  void vault;
  await plants(page, request);
  await page.getByTestId('base-th-note.light').click();
  const menu = page.getByTestId('base-column-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('base-delete-column')).toBeInViewport({ ratio: 1 });
  const { scroll, client, bottom } = await menu.evaluate((element) => ({ scroll: element.scrollHeight, client: element.clientHeight, bottom: element.getBoundingClientRect().bottom }));
  expect(scroll).toBeLessThanOrEqual(client);
  expect(bottom).toBeLessThanOrEqual(800);
});

test('#7: in a tall window a popover is still capped at 36rem (the room on its side only lowers it)', async ({ page, request, vault }) => {
  void vault;
  await plants(page, request);
  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.getByTestId('base-th-note.light').click();
  const menu = page.getByTestId('base-column-menu');
  await expect(menu).toBeVisible();
  const { maxHeight, rem } = await menu.evaluate((element) => ({
    maxHeight: parseFloat(getComputedStyle(element).maxHeight),
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(maxHeight).toBeLessThanOrEqual(36 * rem);
});

test('#11: the paste preview\'s controls sit over their own columns, and a wide sheet stays inside the dialog', async ({ page, request, vault }) => {
  void vault;
  await plants(page, request);
  await page.getByTestId('base-typing-input').click();
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, 'Name\tWater every days\tLight level\tBought on\tIndoor plant\tPot size\nMint\t7\tSun\t2026-01-05\tyes\t12\nBasil\t3\tShade\t2026-02-10\tno\t9\n');
  const preview = page.getByTestId('base-paste-preview');
  await expect(preview).toBeVisible();
  const box = await preview.boundingBox();
  // The dialog itself doesn't scroll sideways: the wide part does, inside it.
  expect(await preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  for (const col of [1, 2, 3, 4, 5]) {
    const name = page.getByTestId(`base-paste-name-${col}`);
    await name.scrollIntoViewIfNeeded();
    const input = (await name.boundingBox())!;
    const cell = (await page.getByTestId('base-paste-sample').locator('tbody tr').first().locator('td').nth(col).boundingBox())!;
    // Over its own column: the input's left edge is within the cell, and it's no wider than the cell.
    expect(input.x, `column ${col}`).toBeGreaterThanOrEqual(cell.x - 1);
    expect(input.x + input.width, `column ${col}`).toBeLessThanOrEqual(cell.x + cell.width + 1);
    // Scrolled to, it's inside the dialog.
    expect(input.x + input.width, `column ${col}`).toBeLessThanOrEqual(box!.x + box!.width);
  }
});

test('#14: each row\'s rename button is named after its row', async ({ page, request, vault }) => {
  void vault;
  await plants(page, request);
  await expect(page.getByRole('button', { name: 'Rename Aloe', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Rename Fern', exact: true })).toHaveCount(1);
  await expect(page.getByTestId('base-table').getByRole('button', { name: 'Rename', exact: true })).toHaveCount(0);
});

for (const language of ['en', 'ru'] as const) {
  test(`#15: the Trash intro and its empty state mention databases and their rows (${language})`, async ({ page, vault }) => {
    void vault;
    await page.addInitScript((value) => window.localStorage.setItem('gumply:language', value), language);
    await page.goto('/');
    await page.getByTestId('sidebar-trash').click();
    const words = language === 'en' ? /databases/ : /базы данных/;
    await expect(page.getByTestId('trash-view').locator('header')).toContainText(words);
    await expect(page.getByTestId('trash-empty-state')).toContainText(language === 'en' ? /a database/ : /базы данных/);
  });
}

test('#18: ru: the Select picker\'s placeholder fits its field', async ({ page, request, vault }) => {
  void vault;
  await plants(page, request, 'ru');
  await page.locator('[data-row-id="Plants/Aloe"] [data-grid-col="1"]').click();
  const search = page.getByTestId('base-select-search');
  await expect(search).toBeVisible();
  const fits = await search.evaluate((element) => {
    const input = element as HTMLInputElement;
    const style = getComputedStyle(input);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    return { text: input.placeholder, needed: Math.ceil(context.measureText(input.placeholder).width), room };
  });
  expect(fits.needed, fits.text).toBeLessThanOrEqual(fits.room);
});
