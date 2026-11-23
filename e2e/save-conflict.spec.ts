import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL } from './support/env';

/**
 * #chbpc9yb: a save conflict on a note (D22). "Keep mine" gives the keys back
 * to the editor (F2); "Reload" keeps the unsaved text in History as "Before
 * reload" first (F5, spec/api v1.34), and asks before dropping it when that
 * can't be done.
 *
 * The conflict is made deterministic: the first save of the page answers 409,
 * as the server does when the file changed on disk.
 */

async function openInConflict(page: Page, vault: { seed: (pages: { title: string; content?: string }[]) => Promise<{ id: string }[]> }) {
  const [note] = await vault.seed([{ title: 'Plan', content: 'Saved line.' }]);
  let conflicts = 1;
  await page.route('**/api/pages/Plan', async (route) => {
    if (route.request().method() === 'PUT' && conflicts > 0 && !(route.request().postData() ?? '').includes('"force":true')) {
      conflicts -= 1;
      await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'This page changed on disk.' }) });
      return;
    }
    await route.continue();
  });
  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  const body = page.getByTestId('editor-content');
  await body.getByText('Saved line.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Unsaved words');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict', { timeout: 10_000 });
  return note!.id;
}

const historyItems = async (request: APIRequestContext, id: string) =>
  ((await (await request.get(`${API_URL}/api/history/${encodeURIComponent(id)}`)).json()) as { items: Array<{ file: string; reason?: string }> }).items;

test('Keep mine: the file gets my text, and typing goes on at the caret (F2)', async ({ page, vault }) => {
  await openInConflict(page, vault);
  await page.getByTestId('conflict-keep-mine').click();
  await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'conflict');
  // No click back into the editor: the next keys land where I was typing.
  await page.keyboard.type(' and more');
  await expect(page.getByTestId('editor-content')).toContainText('Saved line. Unsaved words and more');
});

test('Reload keeps the unsaved text in History as "Before reload", then loads the file (F5)', async ({ page, vault, request }) => {
  const id = await openInConflict(page, vault);
  await page.getByTestId('conflict-reload').click();
  await expect(page.getByTestId('editor-content')).not.toContainText('Unsaved words');
  await expect(page.getByTestId('editor-content')).toContainText('Saved line.');

  const kept = (await historyItems(request, id)).find((item) => item.reason === 'before-reload');
  expect(kept).toBeDefined();
  const text = await (await request.get(`${API_URL}/api/history/${encodeURIComponent(id)}/${encodeURIComponent(kept!.file)}`)).text();
  expect(text).toContain('Saved line. Unsaved words');

  // The History panel says what it is.
  await page.getByTestId(`page-item-${id}`).hover();
  await page.getByTestId(`page-menu-button-${id}`).click();
  await page.getByTestId(`page-history-${id}`).click();
  await expect(page.getByTestId('history-dialog')).toContainText('Before reload');
});

test('if the unsaved text can\'t be kept, Reload asks first; Cancel keeps it, Reload anyway drops it (F5)', async ({ page, vault }) => {
  await openInConflict(page, vault);
  await page.route('**/api/history/**/unsaved', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));

  await page.getByTestId('conflict-reload').click();
  const dialog = page.getByTestId('reload-not-kept');
  await expect(dialog).toContainText("Your unsaved text couldn't be kept in History.");
  await page.getByTestId('reload-not-kept-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('editor-content')).toContainText('Unsaved words');

  await page.getByTestId('conflict-reload').click();
  await page.getByTestId('reload-not-kept-confirm').click();
  await expect(page.getByTestId('editor-content')).not.toContainText('Unsaved words');
  await expect(page.getByTestId('editor-content')).toContainText('Saved line.');
});
