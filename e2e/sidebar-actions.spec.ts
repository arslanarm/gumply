import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * v0.6 P3 batch from the everyday-use hunt (#ux5cukze): right-click menu on
 * sidebar rows, Duplicate and Copy link, inline #tag chips, the window title,
 * distinct names for new boards, and text room in wide round shapes.
 */

interface BoardDoc {
  meta: { id: string; title: string };
  board: { nodes: Array<{ id: string; text?: string }>; edges: unknown[] };
}

async function createBoard(request: APIRequestContext, title: string): Promise<BoardDoc> {
  const response = await request.post('/api/boards', { data: { title } });
  expect(response.status()).toBe(201);
  return (await response.json()) as BoardDoc;
}

async function getBoard(request: APIRequestContext, id: string): Promise<BoardDoc> {
  const response = await request.get(`/api/boards/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as BoardDoc;
}

async function saveNodes(request: APIRequestContext, id: string, nodes: unknown[]) {
  const response = await request.put(`/api/boards/${encodeURIComponent(id)}`, { data: { board: { nodes, edges: [] } } });
  expect(response.ok()).toBe(true);
}

const hashOf = (id: string) => `#/${id.split('/').map(encodeURIComponent).join('/')}`;

test.describe('sidebar row menu (#ux5cukze)', () => {
  test('right-click opens the ⋯ menu at the pointer; Shift+F10 opens it from the keyboard', async ({ page, vault }) => {
    await vault.seed([{ title: 'Alpha', content: 'A' }, { title: 'Beta', content: 'B' }]);
    await page.goto(`/${hashOf('Beta')}`);
    const row = page.getByTestId('page-item-Alpha');
    const box = (await row.boundingBox())!;
    const at = { x: box.x + 40, y: box.y + box.height / 2 };
    await page.mouse.click(at.x, at.y, { button: 'right' });

    const menu = page.getByTestId('page-menu-Alpha');
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    // At the pointer (a few px of the menu's pop-in animation allowed).
    expect(Math.abs(menuBox.x - at.x)).toBeLessThan(8);
    expect(Math.abs(menuBox.y - at.y)).toBeLessThan(8);
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Rename',
      'Duplicate',
      'Copy link',
      'Move to…',
      'New sub-page',
      'Add whiteboard inside',
      'Add view of pages inside',
      'New page from template…',
      'Import from Notion…',
      'Export as HTML…',
      'Export as PDF…',
      'History…',
      'Delete page',
    ]);
    // Right-click didn't open the page.
    await expect(page).toHaveURL(/#\/Beta$/);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    // Keyboard: Shift+F10 on the focused row, first item focused, arrows move.
    await row.focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible();
    await expect(page.getByTestId('rename-page-Alpha')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('duplicate-page-Alpha')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(page.getByTestId('delete-page-Alpha')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(row).toBeFocused();
  });

  test("a row opened from a hidden rows folder shows its database as the selected sidebar item (#7prbquxu, spec §3 note e)", async ({ page, request, vault }) => {
    void vault;
    expect((await request.post(`${API_URL}/api/bases`, { data: { title: 'People', rows: true, viewName: 'Table' } })).status()).toBe(201);
    await request.post(`${API_URL}/api/pages`, { data: { title: 'Ann', parentId: 'People' } });
    await page.goto(`/#/${encodeURIComponent('People')}/Ann`);
    await expect(page.getByTestId('editor-content')).toBeVisible();
    // The row's folder is hidden, so the database item stands for it, selected.
    await expect(page.getByTestId('page-item-People/Ann')).toHaveCount(0);
    await expect(page.locator('[data-page-id="People.base"]')).toHaveAttribute('aria-selected', 'true');
  });

  test("a database's own rows folder is hidden under it; its ⋯ menu shows them, and the menu's exact list (#7prbquxu phase 4)", async ({ page, request, vault }) => {
    void vault;
    const created = await request.post(`${API_URL}/api/bases`, { data: { title: 'People', rows: true, viewName: 'Table' } });
    expect(created.status()).toBe(201);
    await request.post(`${API_URL}/api/pages`, { data: { title: 'Ann', parentId: 'People' } });
    await page.goto('/');
    await expect(page.getByTestId('page-item-People.base')).toBeVisible();
    // The rows folder and its rows aren't in the tree; the database item stands for them.
    await expect(page.getByTestId('page-item-People')).toHaveCount(0);
    await expect(page.getByTestId('page-item-People/Ann')).toHaveCount(0);

    await page.getByTestId('page-item-People.base').hover();
    await page.getByTestId('page-menu-button-People.base').click();
    const menu = page.getByTestId('page-menu-People.base');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Rename',
      'Duplicate',
      'Copy link',
      'Move to…',
      'Show rows in the sidebar',
      'New page from template…',
      'History…',
      'Delete database',
    ]);
    await page.getByTestId('toggle-rows-People.base').click();
    await expect(page.getByTestId('page-item-People')).toBeVisible();
    await expect.poll(async () => (await request.get(`${API_URL}/api/bases/People.base`)).json().then((doc: { config: { gumply?: { showRows?: boolean } } }) => doc.config.gumply?.showRows)).toBe(true);

    // And back: hidden again.
    await page.getByTestId('page-item-People.base').hover();
    await page.getByTestId('page-menu-button-People.base').click();
    await expect(page.getByTestId('toggle-rows-People.base')).toHaveText('Hide rows in the sidebar');
    await page.getByTestId('toggle-rows-People.base').click();
    await expect(page.getByTestId('page-item-People')).toHaveCount(0);

    // Delete: it asks whether its rows go too (yes by default), and both go to the Trash as one item.
    await page.getByTestId('page-item-People.base').hover();
    await page.getByTestId('page-menu-button-People.base').click();
    await page.getByTestId('delete-page-People.base').click();
    await expect(page.getByTestId('delete-confirm-dialog')).toContainText('Also move its 1 row to the Trash');
    await expect(page.getByTestId('delete-with-rows')).toBeChecked();
    await page.getByTestId('delete-confirm').click();
    await expect(page.getByTestId('page-item-People.base')).toHaveCount(0);
    await expect.poll(async () => (await request.get(`${API_URL}/api/pages`)).json().then((list: Array<{ id: string }>) => list.some((meta) => meta.id.startsWith('People')))).toBe(false);
    await expect.poll(async () => ((await (await request.get(`${API_URL}/api/trash`)).json()) as unknown[]).length).toBe(1);
  });

  test('Duplicate a page: "<Title> copy" next to it, same body, no sub-pages, opened with the title selected', async ({ page, request, vault }) => {
    await vault.seed([
      { title: 'Projects', content: '' },
      { title: 'Plan', content: 'Steps:\n\n- one\n- two', parentId: 'Projects', icon: '🗺️' },
      { title: 'Detail', content: 'deep', parentId: 'Projects/Plan' },
    ]);
    await page.goto(`/${hashOf('Projects/Plan')}`);
    await page.getByTestId('page-item-Projects/Plan').click({ button: 'right' });
    await expect(page.getByTestId('duplicate-page-Projects/Plan')).toHaveAttribute('title', "Sub-pages aren't copied");
    await page.getByTestId('duplicate-page-Projects/Plan').click();

    await expect(page).toHaveURL(/#\/Projects\/Plan%20copy$/);
    const copy = await api.getPage(request, 'Projects/Plan copy');
    expect(copy).toMatchObject({ title: 'Plan copy', parentId: 'Projects', icon: '🗺️', content: 'Steps:\n\n- one\n- two' });
    expect((await api.listPages(request)).some((item) => item.parentId === 'Projects/Plan copy')).toBe(false);
    // Title selected: typing renames the copy.
    const title = page.getByTestId('page-title-input');
    await expect(title).toBeFocused();
    await page.keyboard.type('Plan B');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/Projects\/Plan%20B$/);
  });

  test('Duplicate a board copies the canvas', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Home', content: 'x' }]);
    const board = await createBoard(request, 'Map');
    await saveNodes(request, board.meta.id, [
      { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'Pin', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 200, height: 200 },
    ]);
    await page.goto(`/${hashOf('Home')}`);
    await page.getByTestId('page-item-Map.canvas').click({ button: 'right' });
    await expect(page.getByTestId('duplicate-page-Map.canvas')).not.toHaveAttribute('title', /.+/);
    await page.getByTestId('duplicate-page-Map.canvas').click();
    await expect(page).toHaveURL(/#\/Map%20copy\.canvas$/);
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    const copy = await getBoard(request, 'Map copy.canvas');
    expect(copy.meta.title).toBe('Map copy');
    expect(copy.board.nodes.map((node) => node.text)).toEqual(['Pin']);
    // The original is untouched.
    expect((await getBoard(request, 'Map.canvas')).meta.title).toBe('Map');
  });

  test.describe('Copy link', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
    test('copies [[Title]] for a page and [[X.canvas|X]] for a board, with a toast', async ({ page, request, vault }) => {
      await vault.seed([{ title: 'Alpha', content: 'A' }]);
      await createBoard(request, 'Map');
      await page.goto(`/${hashOf('Alpha')}`);

      await page.getByTestId('page-item-Alpha').click({ button: 'right' });
      await page.getByTestId('copy-link-Alpha').click();
      await expect(page.getByTestId('undo-toast')).toContainText('Link copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('[[Alpha]]');

      await page.getByTestId('page-item-Map.canvas').click({ button: 'right' });
      await page.getByTestId('copy-link-Map.canvas').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('[[Map.canvas|Map]]');
    });
  });
});

test.describe('inline #tags and the window title (#ux5cukze)', () => {
  test('#tags are chips (the file is unchanged); a click searches for the tag', async ({ page, request, vault }) => {
    const body = 'Plan #design for #q3/launch, not `#code` or issue#12.';
    await vault.seed([{ title: 'Roadmap', content: body }, { title: 'Other', content: 'Also #design here' }]);
    await page.goto(`/${hashOf('Roadmap')}`);
    const chips = page.getByTestId('tag-chip');
    await expect(chips).toHaveText(['#design', '#q3/launch']);
    await expect(page.getByTestId('editor-content')).toContainText('Plan #design for #q3/launch');

    await chips.first().click();
    const input = page.getByTestId('quick-switcher-input');
    await expect(input).toHaveValue('#design');
    await expect(page.getByTestId('quick-switcher')).toContainText('Other');
    await page.keyboard.press('Escape');
    // Only a look: the Markdown on disk is what it was.
    expect((await api.getPage(request, 'Roadmap')).content).toBe(body);
  });

  test('the window title is "<Page> — <Vault folder> — Gumply"', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Alpha', content: 'A' }]);
    await createBoard(request, 'Map');
    const folder = path.basename(E2E_VAULT);
    await page.goto(`/${hashOf('Alpha')}`);
    await expect(page).toHaveTitle(`Alpha — ${folder} — Gumply`);
    await page.getByTestId('page-item-Map.canvas').click();
    await expect(page).toHaveTitle(`Map — ${folder} — Gumply`);
  });
});

test.describe('boards (#ux5cukze)', () => {
  test('three new whiteboards get three distinct names in the tree', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Home', content: 'x' }]);
    await page.goto(`/${hashOf('Home')}`);
    for (const id of ['Untitled whiteboard.canvas', 'Untitled whiteboard 2.canvas', 'Untitled whiteboard 3.canvas']) {
      await page.getByTestId('new-board-button').click();
      // New whiteboard opens the template gallery (#yewapn9k): Blank.
      await page.getByTestId('template-blank').click();
      await expect(page.getByTestId(`page-item-${id}`)).toBeVisible();
    }
    await expect(page.locator('[data-page-id$=".canvas"] .page-item-title')).toHaveText([
      'Untitled whiteboard',
      'Untitled whiteboard 2',
      'Untitled whiteboard 3',
    ]);
    const titles = (await api.listPages(request)).filter((item) => item.id.endsWith('.canvas')).map((item) => item.title).sort();
    expect(titles).toEqual(['Untitled whiteboard', 'Untitled whiteboard 2', 'Untitled whiteboard 3']);
  });

  test('a wide, short ellipse and diamond keep room for their text', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Home', content: 'x' }]);
    const board = await createBoard(request, 'Shapes');
    const shape = (id: string, shapeKind: string, x: number) => ({
      id,
      type: 'text',
      text: 'Ship it',
      gumply: { kind: 'shape', shape: shapeKind },
      x,
      y: 0,
      width: 220,
      height: 80,
    });
    await saveNodes(request, board.meta.id, [shape('aaaaaaaaaaaaaaa1', 'ellipse', 0), shape('aaaaaaaaaaaaaaa2', 'diamond', 300)]);
    await page.goto(`/${hashOf('Shapes.canvas')}`);
    const texts = page.locator('.board-shape-text');
    await expect(texts).toHaveCount(2);
    for (const index of [0, 1]) {
      // Was 10 px (the minimum): the box was ~8 px tall.
      await expect
        .poll(async () => Number.parseFloat(await texts.nth(index).evaluate((element) => getComputedStyle(element).fontSize)))
        .toBeGreaterThanOrEqual(14);
    }
  });
});
