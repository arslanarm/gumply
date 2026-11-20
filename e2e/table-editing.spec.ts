import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/** #7witbbun: Notion-style editable tables, saved as GFM. */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

const fileOf = async (request: Parameters<typeof api.getPage>[0], id: string) =>
  (await api.getPage(request, id)).content;

test('/table, typing with Tab (adds a row at the end) and Enter, saved as GFM', async ({
  page,
  vault,
  request,
}) => {
  const [created] = await vault.seed([{ title: 'New table', content: 'Intro' }]);
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  await expect(page.getByTestId('slash-menu-item-table')).toBeVisible();
  await page.keyboard.press('Enter');

  await expect(body.locator('table th')).toHaveCount(3);
  await expect(body.locator('table td')).toHaveCount(6);

  // Caret starts in the first header cell.
  for (const text of ['Name', 'Qty', 'Note', 'Apples', '3', 'red', 'Pears', '5', 'green']) {
    await page.keyboard.type(text);
    await page.keyboard.press('Tab');
  }
  // Tab in the last cell added a row; Enter moves down a column.
  await expect(body.locator('table tr')).toHaveCount(4);
  await page.keyboard.type('Plums');
  await page.keyboard.press('Enter');
  await page.keyboard.type('More');
  await expect(body.locator('table tr')).toHaveCount(5);

  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe(
    [
      'Intro',
      '',
      '| Name | Qty | Note |',
      '|---|---|---|',
      '| Apples | 3 | red |',
      '| Pears | 5 | green |',
      '| Plums |  |  |',
      '| More |  |  |',
    ].join('\n'),
  );

  await page.reload();
  await expect(page.getByTestId('editor-content').locator('table tr')).toHaveCount(5);
});

test('+ bars add a row and a column; menus delete them; alignment is kept', async ({
  page,
  vault,
  request,
}) => {
  const source = '| A | B |\n|:--|--:|\n| 1 | 2 |';
  const [created] = await vault.seed([{ title: 'Edit table', content: `Intro\n\n${source}` }]);
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  const table = body.locator('table');
  await expect(table.locator('td').first()).toHaveText('1');

  await table.locator('td').first().hover();
  await page.getByTestId('table-add-row').click();
  await expect(table.locator('tr')).toHaveCount(3);
  await table.locator('td').first().hover();
  await page.getByTestId('table-add-col').click();
  await expect(table.locator('tr').first().locator('th')).toHaveCount(3);

  await table.locator('tr').nth(2).locator('td').first().click();
  await page.keyboard.type('x');
  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe(
    'Intro\n\n| A | B |  |\n|:--|--:|---|\n| 1 | 2 |  |\n| x |  |  |',
  );

  // Delete the new row and the new column via the handle menus.
  await table.locator('tr').nth(2).locator('td').first().hover();
  await page.getByTestId('table-row-handle').click();
  await page.getByTestId('table-menu-delete-row').click();
  await expect(table.locator('tr')).toHaveCount(2);
  await table.locator('tr').nth(1).locator('td').nth(2).hover();
  await page.getByTestId('table-col-handle').click();
  await page.getByTestId('table-menu-delete-column').click();
  await expect(table.locator('tr').first().locator('th')).toHaveCount(2);

  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe('Intro\n\n| A | B |\n|:--|--:|\n| 1 | 2 |');
});

test('column alignment, moving a row and the header-row toggle round-trip', async ({
  page,
  vault,
  request,
}) => {
  const [created] = await vault.seed([
    { title: 'Shape', content: 'Intro\n\n| H1 | H2 |\n|---|---|\n| a | b |\n| c | d |' },
  ]);
  await page.goto('/');
  const table = page.getByTestId('editor-content').locator('table');
  await expect(table.locator('td').first()).toHaveText('a');

  await table.locator('td').nth(1).hover();
  await page.getByTestId('table-col-handle').click();
  await page.getByTestId('table-menu-align-center').click();

  await table.locator('tr').nth(2).locator('td').first().hover();
  await page.getByTestId('table-row-handle').click();
  await page.getByTestId('table-menu-move-up').click();

  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe(
    'Intro\n\n| H1 | H2 |\n|---|:-:|\n| c | d |\n| a | b |',
  );

  await table.locator('th').first().hover();
  await page.getByTestId('table-row-handle').click();
  await page.getByTestId('table-menu-toggle-header').click();
  await expect(table.locator('th')).toHaveCount(0);
  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe(
    'Intro\n\n|  |  |\n|---|:-:|\n| H1 | H2 |\n| c | d |\n| a | b |',
  );
  await page.reload();
  const reloaded = page.getByTestId('editor-content').locator('table');
  await expect(reloaded.locator('tr')).toHaveCount(3);
  await expect(reloaded.locator('th')).toHaveCount(0);
});

test('an untouched table is saved byte-for-byte when another line is edited', async ({
  page,
  vault,
  request,
}) => {
  const source = 'Name | Score\n:--- | ---:\nAnn  | 10\nBob  | 7 \\| 8';
  const content = `Intro\n\n${source}`;
  const [created] = await vault.seed([{ title: 'Keep', content }]);
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  await expect(body.locator('table td').first()).toHaveText('Ann');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe(content.replace('Intro', 'Intro!'));
});

test('Shift+Tab and arrows move between cells; marks and [[links]] in cells; Delete table', async ({
  page,
  vault,
  request,
}) => {
  const [target] = await vault.seed([{ title: 'Target page', content: 'x' }]);
  const [created] = await vault.seed([
    { title: 'Nav', content: 'Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nOutro' },
  ]);
  void target;
  await page.goto(`/#/${encodeURIComponent(created!.id)}`);
  const table = page.getByTestId('editor-content').locator('table');
  await table.locator('td').nth(1).click(); // "2"
  await page.keyboard.press('End');

  await page.keyboard.press('Shift+Tab'); // → "1"
  await page.keyboard.type('!');
  await page.keyboard.press('ArrowDown'); // → row below, same column ("3")
  await page.keyboard.press('End');
  await page.keyboard.type('?');
  await expect(table.locator('td').nth(0)).toHaveText('1!');
  await expect(table.locator('td').nth(2)).toHaveText('3?');

  // Inline marks and a page link with an alias inside a cell.
  await table.locator('td').nth(3).click();
  await page.keyboard.press('End');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type(' bold');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.type(' [[Target page|the target]]');
  await expect(table.locator('td').nth(3).getByTestId('wiki-link-Target page')).toBeVisible();

  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe(
    'Intro\n\n| A | B |\n|---|---|\n| 1! | 2 |\n| 3? | 4 **bold** [[Target page\\|the target]] |\n\nOutro',
  );
  await page.reload();
  await expect(
    page.getByTestId('editor-content').locator('table td').nth(3).getByTestId('wiki-link-Target page'),
  ).toContainText('the target');

  const reloaded = page.getByTestId('editor-content').locator('table');
  await reloaded.locator('td').first().hover();
  await page.getByTestId('table-row-handle').click();
  await page.getByTestId('table-menu-delete-table').click();
  await expect(page.getByTestId('editor-content').locator('table')).toHaveCount(0);
  await waitSaved(page);
  expect(await fileOf(request, created!.id)).toBe('Intro\n\nOutro');
});
