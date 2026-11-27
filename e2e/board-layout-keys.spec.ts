import { expect, test, type Page } from '@playwright/test';

/**
 * #9ajce8q3: board shortcuts on a non-Latin layout. On ЙЦУКЕН the key labelled V types «м» and ] types «ъ», so
 * shortcuts read from `event.key` never fired. A non-Latin key falls back to the key's position (`event.code`); a
 * Latin layout (QWERTY, Dvorak, Colemak) keeps its letters. Driven through the board lab with synthetic key events
 * carrying the `key` and `code` a Russian layout sends.
 */

interface BoardLike {
  nodes: Array<{ id: string; text?: string }>;
}
const board = (page: Page): Promise<BoardLike> => page.evaluate(() => (window as unknown as { __board: { get(): BoardLike } }).__board.get());

async function openLab(page: Page) {
  await page.goto('/board-lab.html?theme=light&reset=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
}

/** A keydown as a given layout sends it, at the focused element (the board when nothing is focused). */
async function keydown(page: Page, init: { key: string; code: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) {
  await page.evaluate((options) => {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { ...options, bubbles: true, cancelable: true }));
  }, init);
}

test('ru layout: tool letters pick their tools by the key\'s position', async ({ page }) => {
  await openLab(page);
  for (const [key, code, tool] of [
    ['т', 'KeyN', 'sticky'],
    ['е', 'KeyT', 'text'],
    ['а', 'KeyF', 'frame'],
    ['з', 'KeyP', 'pen'],
    ['р', 'KeyH', 'hand'],
    ['с', 'KeyC', 'connector'],
    ['м', 'KeyV', 'select'],
  ] as const) {
    await keydown(page, { key, code });
    await expect(page.getByTestId(`board-tool-${tool}`), `${key} (${code})`).toHaveAttribute('aria-pressed', 'true');
  }
});

test('ru layout: ъ / х bring to front and send to back; Ctrl+я undoes', async ({ page }) => {
  // Two stickies seeded through the lab's storage (double-clicks raced the board's first layout).
  await page.goto('/board-lab.html?reset=1');
  await page.evaluate((json) => window.localStorage.setItem('gumply:board-lab:lab', json), JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: 'A', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 200, height: 200, color: '3' },
      { id: 'b', type: 'text', text: 'B', gumply: { kind: 'sticky' }, x: 400, y: 0, width: 200, height: 200, color: '3' },
    ],
    edges: [],
  }));
  await page.goto('/board-lab.html?theme=light');
  await expect(page.getByTestId('board-sticky')).toHaveCount(2);
  const order = async () => (await board(page)).nodes.map((node) => node.text).join(',');
  expect(await order()).toBe('A,B');
  await page.getByTestId('board-sticky').first().click();
  await keydown(page, { key: 'ъ', code: 'BracketRight' });
  await expect.poll(order).toBe('B,A');
  await keydown(page, { key: 'х', code: 'BracketLeft' });
  await expect.poll(order).toBe('A,B');
  // Undo by the Z key's position: the last reorder is undone.
  await keydown(page, { key: 'я', code: 'KeyZ', ctrlKey: true });
  await expect.poll(order).toBe('B,A');
});

test('a Latin layout keeps its letters: Dvorak\'s "n" (on the KeyL position) is still Sticky, not Connector', async ({ page }) => {
  await openLab(page);
  await keydown(page, { key: 'n', code: 'KeyL' });
  await expect(page.getByTestId('board-tool-sticky')).toHaveAttribute('aria-pressed', 'true');
});
