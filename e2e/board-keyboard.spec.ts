import { expect, test, type Page } from '@playwright/test';
import { test as vaultTest } from './fixtures';

/**
 * #pujmbsyz (a11y audit P2 4): boards from the keyboard. Focus selects an
 * object and Tab walks them in reading order; Enter edits, Esc leaves the
 * text with focus back on the object; arrows move 8 px (Shift 40); Delete
 * deletes, with undo; a tool + Enter places an object in the middle of the
 * view. A live region announces selection, moves, additions and deletes.
 */

interface NodeLike { id: string; text?: string; x: number; y: number; width: number; height: number }
const board = (page: Page): Promise<{ nodes: NodeLike[] }> =>
  page.evaluate(() => (window as unknown as { __board: { get(): { nodes: NodeLike[] } } }).__board.get());

async function openLab(page: Page) {
  await page.goto('/board-lab.html?theme=light&reset=1');
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
}

async function addSticky(page: Page, x: number, y: number, text: string) {
  await page.mouse.dblclick(x, y);
  await expect(page.getByTestId('board-text-editor')).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
}

/** Three stickies in two rows (B is a little lower than A, still the same row), then nothing selected. */
async function threeStickies(page: Page) {
  await addSticky(page, 700, 300, 'B');
  await addSticky(page, 400, 290, 'A');
  await addSticky(page, 400, 560, 'C');
  await page.keyboard.press('Escape');
  const nodes = (await board(page)).nodes;
  const id = (text: string) => nodes.find((node) => node.text === text)!.id;
  return { a: id('A'), b: id('B'), c: id('C') };
}

const focusedNodeId = (page: Page) =>
  page.evaluate(() => (document.activeElement?.closest('.react-flow__node') as HTMLElement | null)?.dataset.id ?? null);
const selectedIds = (page: Page) =>
  page.locator('.react-flow__node.selected').evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.id));
const announcer = (page: Page) => page.getByTestId('board-announcer');

test.describe('boards from the keyboard (#pujmbsyz)', () => {
  test('Tab and Shift+Tab walk the objects in reading order; focus selects and is announced', async ({ page }) => {
    await openLab(page);
    const { a, b, c } = await threeStickies(page);
    await page.getByTestId('board').focus();

    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(a);
    await expect.poll(() => selectedIds(page)).toEqual([a]);
    await expect(announcer(page)).toHaveText('Selected: Sticky note: A');

    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(b);
    await expect.poll(() => selectedIds(page)).toEqual([b]);
    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(c);
    await page.keyboard.press('Shift+Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(b);
    await expect(announcer(page)).toHaveText('Selected: Sticky note: B');
  });

  test('Enter edits the text; Esc leaves it with focus back on the object', async ({ page }) => {
    await openLab(page);
    const { a, b } = await threeStickies(page);
    await page.getByTestId('board').focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(a);

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-text-editor')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' more');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
    await expect.poll(() => focusedNodeId(page)).toBe(a);
    expect((await board(page)).nodes.find((node) => node.id === a)?.text).toBe('A more');
    // Still on the keyboard: Tab goes on from here.
    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(b);
  });

  test('arrows move the selection 8 px, Shift+arrows 40 px, and say so', async ({ page }) => {
    await openLab(page);
    const { a } = await threeStickies(page);
    const before = (await board(page)).nodes.find((node) => node.id === a)!;
    await page.getByTestId('board').focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(a);

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    await expect.poll(async () => (await board(page)).nodes.find((node) => node.id === a)).toMatchObject({ x: before.x + 8, y: before.y + 40 });
    await expect(announcer(page)).toContainText('Moved: Sticky note: A');
  });

  test('Delete deletes the selection (announced), and undo brings it back', async ({ page }) => {
    await openLab(page);
    const { a } = await threeStickies(page);
    await page.getByTestId('board').focus();
    await page.keyboard.press('Tab');
    await expect.poll(() => focusedNodeId(page)).toBe(a);

    await page.keyboard.press('Delete');
    await expect.poll(async () => (await board(page)).nodes.map((node) => node.text).sort()).toEqual(['B', 'C']);
    await expect(announcer(page)).toHaveText('Deleted 1 object');
    // The keyboard stays on the board.
    await expect(page.getByTestId('board')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await board(page)).nodes.map((node) => node.text).sort()).toEqual(['A', 'B', 'C']);
  });

  test('a tool + Enter places the object in the middle of the view and focuses its text', async ({ page }) => {
    await openLab(page);
    await page.getByTestId('board').focus();
    await page.keyboard.press('n');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-text-editor')).toBeFocused();
    await expect(announcer(page)).toHaveText('Added: Sticky note');
    await page.keyboard.type('Centre');
    await page.keyboard.press('Escape');

    const root = (await page.getByTestId('board').boundingBox())!;
    const created = (await board(page)).nodes.find((node) => node.text === 'Centre')!;
    const card = (await page.locator(`.react-flow__node[data-id="${created.id}"]`).boundingBox())!;
    expect(Math.abs(card.x + card.width / 2 - (root.x + root.width / 2))).toBeLessThan(4);
    expect(Math.abs(card.y + card.height / 2 - (root.y + root.height / 2))).toBeLessThan(4);
    await expect.poll(() => focusedNodeId(page)).toBe(created.id);
  });
});

test('a card\'s [[ suggestions: the textarea controls the listbox and points at the keyboard\'s option; cleared on Esc', async ({ page }) => {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    ['gumply:board-lab:kb-links', JSON.stringify({ nodes: [{ id: 's1', type: 'text', text: '', x: 200, y: 150, width: 260, height: 200, gumply: { kind: 'sticky' } }], edges: [] })] as const,
  );
  await page.goto('/board-lab.html?id=kb-links&theme=light');
  await expect(page.getByTestId('board')).toBeVisible();
  await page.getByTestId('board-sticky').dblclick();
  const area = page.getByTestId('board-text-editor');
  await expect(area).toBeFocused();
  for (const name of ['aria-controls', 'aria-activedescendant', 'aria-autocomplete']) await expect(area).not.toHaveAttribute(name, /.*/);

  await page.keyboard.type('See [[');
  const menu = page.getByTestId('board-link-menu');
  await expect(menu).toBeVisible();
  const listboxId = await menu.getAttribute('id');
  expect(listboxId).toBeTruthy();
  await expect(area).toHaveAttribute('aria-controls', listboxId!);
  await expect(area).toHaveAttribute('aria-autocomplete', 'list');
  // A textarea keeps its textbox role (HTML allows it no other).
  await expect(area).not.toHaveAttribute('role', /.*/);
  const selected = menu.locator('[role="option"][aria-selected="true"]');
  const first = await selected.getAttribute('id');
  await expect(area).toHaveAttribute('aria-activedescendant', first!);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => selected.getAttribute('id')).not.toBe(first);
  await expect(area).toHaveAttribute('aria-activedescendant', (await selected.getAttribute('id'))!);

  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(area).toBeFocused();
  for (const name of ['aria-controls', 'aria-activedescendant', 'aria-autocomplete']) await expect(area).not.toHaveAttribute(name, /.*/);
});

for (const [language, label] of [['en', 'Select the next / previous object'], ['ru', 'Выбрать следующий / предыдущий объект']] as const) {
  vaultTest(`the ? overlay lists the board keys (${language})`, async ({ page, vault }) => {
    await page.addInitScript((lang) => window.localStorage.setItem('gumply:language', lang), language);
    await vault.seed([{ title: 'Keys', content: 'x' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await page.getByTestId('sidebar').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('?');
    const dialog = page.getByTestId('shortcuts-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(label);
    await expect(dialog).toContainText(language === 'en' ? 'Move by 8 / 40 px' : 'Сдвинуть на 8 / 40 px');
  });
}
