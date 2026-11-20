import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * Whiteboards in the app (W2a, #7752gn9x; spec/whiteboard §2 and §4, D25):
 * tree, New whiteboard, routing, rename, Cmd+K, `/whiteboard`, Linked from,
 * graph node, drag a page onto a board, delete/undo and move.
 */

interface BoardFile {
  nodes: Array<{ id: string; type: string; text?: string; file?: string; gumply?: { kind: string } }>;
  edges: unknown[];
}

interface BoardDoc {
  meta: { id: string; title: string; kind: string; parentId: string | null; updated: string };
  board: BoardFile;
}

async function createBoard(request: APIRequestContext, title: string, parentId?: string): Promise<BoardDoc> {
  const response = await request.post('/api/boards', { data: { title, ...(parentId ? { parentId } : {}) } });
  expect(response.status()).toBe(201);
  return (await response.json()) as BoardDoc;
}

async function getBoard(request: APIRequestContext, id: string): Promise<BoardDoc> {
  const response = await request.get(`/api/boards/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as BoardDoc;
}

async function saveBoard(request: APIRequestContext, id: string, board: BoardFile): Promise<void> {
  const response = await request.put(`/api/boards/${encodeURIComponent(id)}`, { data: { board } });
  expect(response.ok()).toBe(true);
}

const sticky = (id: string, text: string, x = 0) => ({
  id,
  type: 'text',
  text,
  gumply: { kind: 'sticky' },
  x,
  y: 0,
  width: 200,
  height: 200,
  color: '3',
});

const hashOf = (id: string) => `#/${id.split('/').map(encodeURIComponent).join('/')}`;

async function openBoard(page: Page, id: string) {
  await page.goto(`/${hashOf(id)}`);
  await expect(page.getByTestId('board-page')).toBeVisible();
  await expect(page.getByTestId('board')).toBeVisible();
}

test.describe('whiteboards in the app (W2a)', () => {
  test('New whiteboard: opens a board, the title renames the file, and edits save and reload', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    await page.goto('/');
    await page.getByTestId('new-board-button').click();

    await expect(page.getByTestId('board-page')).toBeVisible();
    await expect(page).toHaveURL(/#\/Untitled%20whiteboard\.canvas$/);
    // The title is focused, like a new page: type the name and press Enter.
    await expect(page.getByTestId('page-title-input')).toBeFocused();
    await page.keyboard.type('Sprint board');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#\/Sprint%20board\.canvas$/);

    // In the tree: a board icon, and no "New sub-page" (boards have none).
    const row = page.getByTestId('page-item-Sprint board.canvas');
    await expect(row).toContainText('Sprint board');
    await expect(page.getByTestId('board-icon-Sprint board.canvas')).toBeVisible();
    await expect(page.getByTestId('new-child-button-Sprint board.canvas')).toHaveCount(0);

    // Add a sticky; it autosaves to the renamed file.
    const surface = await page.getByTestId('board').boundingBox();
    if (!surface) throw new Error('no board');
    await page.mouse.dblclick(surface.x + surface.width / 2, surface.y + surface.height / 2);
    await page.keyboard.type('Plan the sprint');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    const saved = await getBoard(request, 'Sprint board.canvas');
    expect(saved.board.nodes).toEqual([expect.objectContaining({ text: 'Plan the sprint', gumply: { kind: 'sticky' } })]);

    await page.reload();
    await expect(page.getByTestId('board-sticky')).toContainText('Plan the sprint');
    expect((await api.listPages(request)).map((item) => item.id).sort()).toEqual(['Notes', 'Sprint board.canvas']);
  });

  test('Add whiteboard inside a page, delete it with Undo, and never move pages under a board', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Project', content: 'Root' }, { title: 'Loose', content: 'x' }]);
    await page.goto('/');
    await page.getByTestId('page-item-Project').hover();
    await page.getByTestId('page-menu-button-Project').click();
    await page.getByTestId('add-board-Project').click();

    await expect(page).toHaveURL(/#\/Project\/Untitled%20whiteboard\.canvas$/);
    const board = (await api.listPages(request)).find((item) => item.id === 'Project/Untitled whiteboard.canvas');
    expect(board).toMatchObject({ kind: 'whiteboard', parentId: 'Project' });
    await expect(page.getByTestId('page-item-Project/Untitled whiteboard.canvas')).toBeVisible();

    // Move dialog for a page never offers a board as the new parent.
    await page.getByTestId('page-item-Loose').hover();
    await page.getByTestId('page-menu-button-Loose').click();
    await page.getByTestId('move-page-Loose').click();
    await expect(page.getByRole('dialog')).toContainText('Project');
    await expect(page.getByRole('dialog')).not.toContainText('Untitled whiteboard');
    await page.keyboard.press('Escape');

    // Delete from the header, then Undo.
    await page.getByTestId('page-item-Project/Untitled whiteboard.canvas').click();
    await expect(page.getByTestId('board-page')).toBeVisible();
    await page.getByTestId('page-item-Project/Untitled whiteboard.canvas').hover();
    await page.getByTestId('page-menu-button-Project/Untitled whiteboard.canvas').click();
    await expect(page.getByTestId('delete-page-Project/Untitled whiteboard.canvas')).toHaveText('Delete whiteboard');
    await page.getByTestId('delete-page-Project/Untitled whiteboard.canvas').click();
    await expect(page.getByText('Whiteboard deleted')).toBeVisible();
    await expect(page.getByTestId('page-item-Project/Untitled whiteboard.canvas')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByTestId('page-item-Project/Untitled whiteboard.canvas')).toBeVisible();
    await expect(page.getByTestId('board-page')).toBeVisible();
  });

  test('Cmd+K finds boards by title and by their text, and creates whiteboards', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    const created = await createBoard(request, 'Roadmap');
    await saveBoard(request, created.meta.id, { nodes: [sticky('aaaaaaaaaaaaaaaa', 'Quarterly kangaroo goals')], edges: [] });

    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByTestId('quick-switcher-input').fill('kangaroo');
    const hit = page.getByTestId('search-result-Roadmap.canvas');
    await expect(hit).toContainText('Roadmap');
    await expect(hit).toContainText('kangaroo');
    await hit.click();
    await expect(page).toHaveURL(/#\/Roadmap\.canvas$/);
    await expect(page.getByTestId('board-sticky')).toContainText('Quarterly kangaroo goals');

    await page.keyboard.press('Control+k');
    await page.getByTestId('quick-switcher-input').fill('Retro');
    await expect(page.getByTestId('search-create')).toHaveText('Create “Retro”');
    await expect(page.getByTestId('search-create-board')).toHaveText('Create whiteboard “Retro”');
    await page.getByTestId('search-create-board').click();
    await expect(page).toHaveURL(/#\/Retro\.canvas$/);
    await expect(page.getByTestId('board-empty')).toBeVisible();
  });

  test('/whiteboard creates a board inside the page and links it; the link opens it', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Kickoff', content: 'Agenda' }]);
    await page.goto(`/${hashOf('Kickoff')}`);
    const editor = page.getByTestId('editor-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/whiteb');
    await expect(page.getByTestId('slash-menu-item-whiteboard')).toBeVisible();
    await page.keyboard.press('Enter');

    const link = page.getByTestId('wiki-link-Kickoff/Untitled whiteboard.canvas');
    await expect(link).toHaveText('Untitled whiteboard');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    // On disk: Obsidian-compatible `[[file.canvas|Title]]`.
    expect((await api.getPage(request, 'Kickoff')).content).toContain('[[Untitled whiteboard.canvas|Untitled whiteboard]]');
    expect((await api.listPages(request)).find((item) => item.id === 'Kickoff/Untitled whiteboard.canvas')).toMatchObject({
      kind: 'whiteboard',
      parentId: 'Kickoff',
    });

    await link.click();
    await expect(page).toHaveURL(/#\/Kickoff\/Untitled%20whiteboard\.canvas$/);
    await expect(page.getByTestId('board-page')).toBeVisible();
  });

  test('Linked from shows boards with a board icon; dragging a page from the sidebar adds a card', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Spec', content: 'The spec' }, { title: 'Design', content: 'Mockups' }]);
    const board = await createBoard(request, 'Map');
    await saveBoard(request, board.meta.id, { nodes: [sticky('bbbbbbbbbbbbbbbb', 'See [[Spec]] first')], edges: [] });

    await page.goto(`/${hashOf('Spec')}`);
    const backlink = page.getByTestId('backlink-Map.canvas');
    await expect(backlink).toContainText('Map');
    await expect(backlink).toContainText('See Spec first');
    await expect(page.getByTestId('backlink-board-icon-Map.canvas')).toBeVisible();
    await backlink.click();
    await expect(page.getByTestId('board-page')).toBeVisible();

    // Drag "Design" from the tree onto the board: a page card.
    const surface = await page.getByTestId('board').boundingBox();
    if (!surface) throw new Error('no board');
    await page
      .getByTestId('page-item-Design')
      .dragTo(page.getByTestId('board'), { targetPosition: { x: surface.width * 0.7, y: surface.height * 0.5 } });
    await expect(page.getByTestId('board-card-page')).toContainText('Design');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    const saved = await getBoard(request, 'Map.canvas');
    expect(saved.board.nodes.find((node) => node.type === 'file')).toMatchObject({ file: 'Design.md' });
    // The tree didn't treat the drop as a move.
    expect((await api.listPages(request)).find((item) => item.id === 'Design')?.parentId).toBeNull();

    // The card opens its page.
    await page.getByTestId('board-card-page').getByTestId('board-card-open').click();
    await expect(page).toHaveURL(/#\/Design$/);
    await expect(page.getByTestId('backlink-Map.canvas')).toBeVisible();
  });

  test.describe('graph', () => {
  // A 3x backing store makes the shape check robust: nodes are only a few px.
  test.use({ deviceScaleFactor: 3 });
  test('the graph draws boards as squares (legend, click opens), and the local graph works on a board', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Alpha', content: 'A' }, { title: 'Beta', content: 'B links [[Alpha]]' }]);
    const board = await createBoard(request, 'Overview');
    await saveBoard(request, board.meta.id, { nodes: [sticky('cccccccccccccccc', '[[Alpha]] and [[Beta]]')], edges: [] });

    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();
    const canvas = page.getByTestId('graph-canvas');
    await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
    await expect(page.getByTestId('graph-legend-board')).toContainText('whiteboard');

    type Probe = { id: string; x: number; y: number; r: number; board: boolean };
    const probe = () =>
      page.evaluate(
        () => (window as unknown as { __gumplyGraphs: Record<string, { nodes: () => Probe[] }> }).__gumplyGraphs['graph-canvas']!.nodes(),
      );
    // Wait for the layout to settle.
    let previous = '';
    await expect
      .poll(async () => {
        const now = JSON.stringify((await probe()).map((node) => [Math.round(node.x), Math.round(node.y)]));
        const still = now === previous;
        previous = now;
        return still;
      }, { intervals: [400] })
      .toBe(true);
    const nodes = await probe();
    const boardNode = nodes.find((node) => node.id === 'Overview.canvas');
    // Not Alpha: the page we came from wears an accent halo.
    const pageNode = nodes.find((node) => node.id === 'Beta');
    if (!boardNode || !pageNode) throw new Error('missing graph nodes');
    expect(boardNode.board).toBe(true);
    expect(pageNode.board).toBe(false);

    // Rendered shape: a square fills its corners, a circle doesn't.
    const box = await canvas.locator('canvas').first().boundingBox();
    if (!box) throw new Error('no canvas');
    const cornerIsPainted = async (node: Probe) => {
      // Outside the dot's circle (1.2r away), inside the board's square (side 2r).
      const offset = node.r * 0.85;
      const shot = await page.screenshot({ clip: { x: box.x + node.x + offset - 0.5, y: box.y + node.y + offset - 0.5, width: 1, height: 1 } });
      const background = await page.screenshot({ clip: { x: box.x + 4, y: box.y + box.height - 8, width: 1, height: 1 } });
      return !shot.equals(background);
    };
    expect(await cornerIsPainted(boardNode)).toBe(true);
    expect(await cornerIsPainted(pageNode)).toBe(false);

    await page.mouse.click(box.x + boardNode.x, box.y + boardNode.y);
    await expect(page).toHaveURL(/#\/Overview\.canvas$/);
    await expect(page.getByTestId('board-page')).toBeVisible();

    // Local graph on the board shows its neighbours.
    await page.getByTestId('local-graph-toggle').click();
    await expect(page.getByTestId('local-graph')).toBeVisible();
    await expect(page.getByTestId('local-graph').locator('[data-graph-ready="true"]')).toBeVisible({ timeout: 15_000 });
    const local = await page.evaluate(() =>
      Object.entries((window as unknown as { __gumplyGraphs: Record<string, { nodes: () => Probe[] }> }).__gumplyGraphs)
        .filter(([key]) => key !== 'graph-canvas')
        .flatMap(([, value]) => value.nodes().map((node) => node.id)),
    );
    expect(local).toEqual(expect.arrayContaining(['Overview.canvas', 'Alpha', 'Beta']));
  });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`a board page renders in the app shell (${theme})`, async ({ page, request, vault }) => {
      await vault.seed([{ title: 'Spec', content: 'x' }]);
      const board = await createBoard(request, 'Theme check');
      await saveBoard(request, board.meta.id, { nodes: [sticky('dddddddddddddddd', 'Hello', 0)], edges: [] });
      await page.addInitScript((value) => window.localStorage.setItem('gumply:theme', value), theme);
      await openBoard(page, board.meta.id);
      await expect(page.getByTestId('page-title-input').or(page.getByTestId('page-title')).first()).toContainText('Theme check');
      await expect(page.getByTestId('board-sticky')).toContainText('Hello');
      // The board fills the pane under the header (full-bleed, not the 820px text column).
      const pane = await page.getByTestId('editor').boundingBox();
      const surface = await page.getByTestId('board').boundingBox();
      if (!pane || !surface) throw new Error('no layout');
      expect(surface.width).toBeGreaterThan(pane.width - 2);
      expect(surface.height).toBeGreaterThan(300);
      const background = await page.getByTestId('board').evaluate((element) => getComputedStyle(element).backgroundColor);
      expect(background).toBe(theme === 'light' ? 'rgb(251, 251, 250)' : 'rgb(22, 22, 22)');
    });
  }
});

test.describe('board uploads that fail (#f6v8z4ti)', () => {
  async function dropFile(page: Page, name: string, size: number, type = 'application/octet-stream') {
    const canvas = page.getByTestId('board');
    const box = (await canvas.boundingBox())!;
    await canvas.evaluate(
      (element, file) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(file.size)], file.name, { type: file.type }));
        const point = { clientX: file.x, clientY: file.y, bubbles: true, cancelable: true, dataTransfer: data };
        element.dispatchEvent(new DragEvent('dragover', point));
        element.dispatchEvent(new DragEvent('drop', point));
      },
      { name, size, type, x: box.x + box.width / 2, y: box.y + box.height / 2 },
    );
  }

  test('an oversize drop shows a calm message, uploads nothing and throws nothing', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let uploads = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/attachments')) uploads += 1;
    });
    const created = await createBoard(request, 'Drops');
    await openBoard(page, created.meta.id);

    await dropFile(page, 'huge.bin', 25 * 1024 * 1024 + 300);
    const notice = page.getByTestId('board-upload-notice');
    await expect(notice).toHaveText(/huge\.bin is too large \(max 25 MB\)/);
    await notice.getByRole('button', { name: 'Dismiss' }).click();
    await expect(notice).toHaveCount(0);
    expect(uploads).toBe(0);
    expect(errors).toEqual([]);
    expect((await getBoard(request, created.meta.id)).board.nodes).toHaveLength(0);
  });

  test('offline: the upload notice says the server can\'t be reached', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/attachments', (route) =>
      route.request().method() === 'POST' ? route.abort('connectionrefused') : route.continue(),
    );
    const created = await createBoard(request, 'Drops offline');
    await openBoard(page, created.meta.id);
    await dropFile(page, 'note.txt', 12, 'text/plain');
    await expect(page.getByTestId('board-upload-notice')).toHaveText(/Couldn't add note\.txt\. Can't reach Gumply's local server\./);
    expect(errors).toEqual([]);
  });

  test('a server failure on upload is a notice too, not an uncaught error', async ({ page, request }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/attachments', (route) =>
      route.request().method() === 'POST' ? route.fulfill({ status: 500, body: 'boom' }) : route.continue(),
    );
    const created = await createBoard(request, 'Drops 500');
    await openBoard(page, created.meta.id);
    await dropFile(page, 'note.txt', 12, 'text/plain');
    await expect(page.getByTestId('board-upload-notice')).toHaveText(/Couldn't add note\.txt \(server error\)/);
    expect(errors).toEqual([]);
  });
});
