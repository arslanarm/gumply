import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #4quachkv (visual QA 5): a sticky note's toolbar is centred over the note, so on a narrow window
 * (a phone, a split screen) it ran under the tool rail and off the board's left edge: its first
 * swatches couldn't be clicked. It stays inside the board, clear of the rail, now. Invented content.
 */
test.use({ viewport: { width: 420, height: 800 } });

const BOARD = {
  nodes: [
    { id: 'a000000000000001', type: 'text', text: 'A sticky note near the left', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 220, height: 200, color: '3' },
    { id: 'a000000000000002', type: 'text', text: 'Another note', gumply: { kind: 'sticky' }, x: 440, y: 0, width: 220, height: 200 },
  ],
  edges: [],
};

test('a selected sticky note\'s toolbar is inside the board and clear of the tool rail, so its first swatch works', async ({ page, request, vault }) => {
  void vault; // resets the vault before and after
  await fs.writeFile(path.join(E2E_VAULT, 'Narrow.canvas'), JSON.stringify(BOARD), 'utf8');
  await expect.poll(async () => (await api.listPages(request)).some((m) => m.id === 'Narrow.canvas'), { timeout: 10_000 }).toBe(true);
  await page.goto('/#/Narrow.canvas');
  await page.getByTestId('board-sticky').first().waitFor();
  await page.getByTestId('board-sticky').first().click();
  const toolbar = page.getByTestId('board-context-toolbar');
  await expect(toolbar).toBeVisible();

  const box = (await toolbar.boundingBox())!;
  const rail = (await page.getByTestId('board-toolbar').boundingBox())!;
  expect(box.x, 'the toolbar starts inside the window').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'and ends inside it').toBeLessThanOrEqual(420);
  const overlapsRail = box.y < rail.y + rail.height && box.y + box.height > rail.y;
  if (overlapsRail) expect(box.x, 'the toolbar is clear of the tool rail').toBeGreaterThanOrEqual(rail.x + rail.width);

  // The first swatch is the element at its own centre (nothing covers it), and a click recolours the note.
  const first = page.getByTestId('board-color-default');
  const swatch = (await first.boundingBox())!;
  const onTop = await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.closest('[data-testid]')?.getAttribute('data-testid'), [swatch.x + swatch.width / 2, swatch.y + swatch.height / 2]);
  expect(onTop).toBe('board-color-default');
  await first.click();
  await expect.poll(async () => JSON.parse(await fs.readFile(path.join(E2E_VAULT, 'Narrow.canvas'), 'utf8')).nodes[0].color ?? null, { timeout: 8_000 }).toBeNull();
});
