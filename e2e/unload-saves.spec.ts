import type { Page } from '@playwright/test';
import { test, expect, api } from './fixtures';
import { API_URL } from './support/env';
import { expectPageTitle } from './support/ui';

/**
 * P1 #3t6v62cb (D14 "never lose typing"): the last edits survive a reload
 * that comes right after typing, before the 600 ms autosave debounce, for a
 * page and for a sticky still being typed in. No "Leave site?" prompt: the
 * pending save goes out as a keepalive request.
 */
function recordDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', (dialog) => {
    seen.push(dialog.type());
    void dialog.accept();
  });
  return seen;
}

test.describe('edits survive an immediate reload (#3t6v62cb)', () => {
  test('a page: type, reload at once, the words are there', async ({ page, vault, request }) => {
    const [seeded] = await vault.seed([{ title: 'Quick', content: 'Start.' }]);
    const dialogs = recordDialogs(page);
    await page.goto(`/#/${seeded.id}`);
    await expectPageTitle(page, 'Quick');

    const body = page.getByTestId('editor').locator('.ProseMirror');
    await body.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Typed right before the reload.');
    await page.reload();

    await expect
      .poll(async () => (await api.getPage(request, seeded.id)).content, { timeout: 5_000 })
      .toBe('Start. Typed right before the reload.');
    await expectPageTitle(page, 'Quick');
    await expect(body).toContainText('Start. Typed right before the reload.');
    expect(dialogs).toEqual([]);
  });

  test('a page: switching away from the tab saves at once too', async ({ page, vault, request }) => {
    const [seeded] = await vault.seed([{ title: 'Hidden', content: 'One.' }]);
    await page.goto(`/#/${seeded.id}`);
    await expectPageTitle(page, 'Hidden');
    await page.getByTestId('editor').locator('.ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Two.');
    // What a tab switch or minimising does (the tab may never come back).
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect
      .poll(async () => (await api.getPage(request, seeded.id)).content, { timeout: 2_000 })
      .toBe('One. Two.');
  });

  test('a sticky still being typed in: reload at once, the text is there', async ({ page, request }) => {
    const created = await request.post(`${API_URL}/api/boards`, { data: { title: 'Trip' } });
    const boardId = ((await created.json()) as { meta: { id: string } }).meta.id;
    const dialogs = recordDialogs(page);
    await page.goto(`/#/${encodeURIComponent(boardId)}`);
    await expect(page.getByTestId('board')).toBeVisible();

    const surface = await page.getByTestId('board').boundingBox();
    if (!surface) throw new Error('no board');
    await page.mouse.dblclick(surface.x + surface.width / 2, surface.y + surface.height / 2);
    await page.keyboard.type('Book flights');
    // Still editing (no blur, no Escape), then reload right away.
    await expect(page.getByTestId('board-text-editor')).toHaveValue('Book flights');
    await page.reload();

    const texts = async () => {
      const response = await request.get(`${API_URL}/api/boards/${encodeURIComponent(boardId)}`);
      const doc = (await response.json()) as { board: { nodes: Array<{ text?: string }> } };
      return doc.board.nodes.map((node) => node.text ?? '');
    };
    await expect.poll(texts, { timeout: 5_000 }).toEqual(['Book flights']);
    await expect(page.getByTestId('board-sticky')).toContainText('Book flights');
    expect(dialogs).toEqual([]);
  });

  test('a sticky being typed in is saved while typing, so the header never says Saved for missing text', async ({
    page,
    request,
  }) => {
    const created = await request.post(`${API_URL}/api/boards`, { data: { title: 'Plans' } });
    const boardId = ((await created.json()) as { meta: { id: string } }).meta.id;
    await page.goto(`/#/${encodeURIComponent(boardId)}`);
    await expect(page.getByTestId('board')).toBeVisible();
    const surface = await page.getByTestId('board').boundingBox();
    if (!surface) throw new Error('no board');
    await page.mouse.dblclick(surface.x + surface.width / 2, surface.y + surface.height / 2);
    await page.keyboard.type('Pack bags');
    // Still in edit mode: after the debounce it is on disk and "Saved" is true.
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    await expect(page.getByTestId('board-text-editor')).toBeVisible();
    const doc = (await (await request.get(`${API_URL}/api/boards/${encodeURIComponent(boardId)}`)).json()) as {
      board: { nodes: Array<{ text?: string }> };
    };
    expect(doc.board.nodes.map((node) => node.text)).toEqual(['Pack bags']);

    // Undo after finishing still takes the whole text back in one step.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('board-sticky')).toHaveCount(0);
  });
});
