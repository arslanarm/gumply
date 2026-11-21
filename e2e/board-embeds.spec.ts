import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { measure } from './support/perf';

/**
 * Boards embedded in pages (spec/v0-6 B, D30, #9ehu8zjg): `![[Board.canvas]]`
 * shows a live, read-only view of the board. Insert (/whiteboard, `![[`,
 * sidebar drop), live update, open, resize (`|480`), a missing board, rename
 * and backlinks, no loops, and scrolling a page with a 1000-object board.
 */

interface BoardNode {
  id: string;
  type: string;
  text?: string;
  file?: string;
  gumply?: { kind: string };
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
}

interface BoardDoc {
  meta: { id: string; title: string; updated: string };
  board: { nodes: BoardNode[]; edges: unknown[] };
}

async function createBoard(request: APIRequestContext, title: string, parentId?: string): Promise<BoardDoc> {
  const response = await request.post('/api/boards', { data: { title, ...(parentId ? { parentId } : {}) } });
  expect(response.status()).toBe(201);
  return (await response.json()) as BoardDoc;
}

async function saveBoard(request: APIRequestContext, id: string, nodes: BoardNode[]): Promise<void> {
  const response = await request.put(`/api/boards/${encodeURIComponent(id)}`, { data: { board: { nodes, edges: [] } } });
  expect(response.ok()).toBe(true);
}

let counter = 0;
const nodeId = () => (counter++).toString(16).padStart(16, '0');

const sticky = (text: string, x = 0, y = 0): BoardNode => ({
  id: nodeId(),
  type: 'text',
  text,
  gumply: { kind: 'sticky' },
  x,
  y,
  width: 200,
  height: 200,
  color: '3',
});

const hashOf = (id: string) => `#/${id.split('/').map(encodeURIComponent).join('/')}`;

async function openPage(page: Page, id: string) {
  await page.goto(`/${hashOf(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

/** Wait for the page's saved body to satisfy `check` (autosave is debounced). */
async function expectSaved(request: APIRequestContext, id: string, check: (content: string) => boolean) {
  await expect.poll(async () => check((await api.getPage(request, id)).content), { timeout: 8_000 }).toBe(true);
}

test.describe('boards embedded in pages (D30)', () => {
  test('/whiteboard → New board here creates a board inside the page and embeds it; Open opens it', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Kickoff', content: 'Agenda' }]);
    await openPage(page, 'Kickoff');
    await page.getByTestId('editor-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/whiteboard');
    await expect(page.getByTestId('slash-menu-item-whiteboard')).toContainText('New board here');
    await expect(page.getByTestId('slash-menu-item-embed-whiteboard')).toContainText('Embed existing board');
    await page.keyboard.press('Enter');

    const embed = page.getByTestId('board-embed');
    await expect(embed).toHaveAttribute('data-board-id', 'Kickoff/Untitled whiteboard.canvas');
    await expect(embed.getByTestId('board-preview')).toBeVisible();
    await expectSaved(request, 'Kickoff', (content) => content === 'Agenda\n\n![[Untitled whiteboard.canvas]]');
    expect((await api.listPages(request)).find((item) => item.id === 'Kickoff/Untitled whiteboard.canvas')).toMatchObject({
      kind: 'whiteboard',
      parentId: 'Kickoff',
    });

    // Hover shows the title and Open.
    await embed.getByTestId('board-embed-frame').hover();
    await expect(embed.getByTestId('board-embed-title')).toHaveText('Untitled whiteboard');
    await expect(embed.getByTestId('board-embed-open')).toBeVisible();
    await embed.getByTestId('board-embed-open').click();
    await expect(page).toHaveURL(/#\/Kickoff\/Untitled%20whiteboard\.canvas$/);
    await expect(page.getByTestId('board-page')).toBeVisible();
  });

  test('`![[` suggests boards only and embeds the pick; the embed is a link (backlinks)', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Intro' }, { title: 'Roadmap page', content: 'x' }]);
    const board = await createBoard(request, 'Roadmap');
    const ship = sticky('Ship v0.6', 0, 0);
    const gate = sticky('Gate', 260, 0);
    const response = await request.put(`/api/boards/${encodeURIComponent(board.meta.id)}`, {
      data: { board: { nodes: [ship, gate], edges: [{ id: nodeId(), fromNode: ship.id, fromSide: 'right', toNode: gate.id, toSide: 'left' }] } },
    });
    expect(response.ok()).toBe(true);

    await openPage(page, 'Notes');
    await page.getByTestId('editor-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('![[Road');
    const menu = page.getByTestId('link-menu');
    await expect(menu).toBeVisible();
    // Only the board, not the page with a similar title, and no Create row.
    await expect(menu.getByRole('option')).toHaveCount(1);
    await expect(menu.getByRole('option')).toContainText('Roadmap');
    await page.keyboard.press('Enter');

    const embed = page.getByTestId('board-embed');
    await expect(embed).toHaveAttribute('data-board-id', 'Roadmap.canvas');
    await expect(embed.locator('.board-node-sticky')).toHaveCount(2);
    await expect(embed).toContainText('Ship v0.6');
    // Connectors are drawn too.
    await expect(embed.locator('.react-flow__edge')).toHaveCount(1);
    await expectSaved(request, 'Notes', (content) => content === 'Intro\n\n![[Roadmap.canvas]]');

    const backlinks = await api.backlinks(request, 'Roadmap.canvas');
    expect(backlinks.map((item) => item.page.id)).toContain('Notes');

    // A click anywhere on the embed opens the board.
    await embed.getByTestId('board-embed-frame').click({ position: { x: 40, y: 200 } });
    await expect(page).toHaveURL(/#\/Roadmap\.canvas$/);
  });

  test('live: a change to the board (in Gumply or on disk) shows in the embed without a reload', async ({ page, request, vault }) => {
    const board = await createBoard(request, 'Live');
    await saveBoard(request, board.meta.id, [sticky('First')]);
    await vault.seed([{ title: 'Status', content: 'Before\n\n![[Live.canvas]]\n\nAfter' }]);
    await openPage(page, 'Status');
    const embed = page.getByTestId('board-embed');
    await expect(embed).toContainText('First');
    // Untouched, the page isn't rewritten.
    expect((await api.getPage(request, 'Status')).content).toBe('Before\n\n![[Live.canvas]]\n\nAfter');

    await saveBoard(request, 'Live.canvas', [sticky('First'), sticky('Second', 260, 0)]);
    await expect(embed).toContainText('Second', { timeout: 8_000 });
    await expect(embed.locator('.board-node-sticky')).toHaveCount(2);
  });

  test('an embed inside running text stays text and a link; an unrelated edit leaves that line byte for byte', async ({ page, request, vault }) => {
    const board = await createBoard(request, 'Inline');
    await saveBoard(request, board.meta.id, [sticky('x')]);
    const file = 'see ![[Inline.canvas]] here\n\nOther text';
    await vault.seed([{ title: 'Prose', content: file }]);
    await openPage(page, 'Prose');
    // Not a live block: the sentence keeps its link.
    await expect(page.getByTestId('board-embed')).toHaveCount(0);
    await expect(page.getByTestId('wiki-link-Inline.canvas')).toBeVisible();
    expect((await api.getPage(request, 'Prose')).content).toBe(file);

    // Edit the other paragraph only.
    await page.getByTestId('editor-content').getByText('Other text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(', edited');
    await expectSaved(request, 'Prose', (content) => content.endsWith('edited'));
    expect((await api.getPage(request, 'Prose')).content).toBe('see ![[Inline.canvas]] here\n\nOther text, edited');
  });

  test('resize: dragging the bottom edge sets the height, saved Obsidian-style as |480', async ({ page, request, vault }) => {
    const board = await createBoard(request, 'Tall');
    await saveBoard(request, board.meta.id, [sticky('Hi')]);
    await vault.seed([{ title: 'Doc', content: '![[Tall.canvas]]\n\nEnd' }]);
    await openPage(page, 'Doc');
    const frame = page.getByTestId('board-embed-frame');
    await expect(frame).toBeVisible();
    expect(Math.round((await frame.boundingBox())!.height)).toBe(360);

    const handle = page.getByTestId('board-embed-resize');
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 4 });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 4 });
    await page.mouse.up();
    expect(Math.round((await frame.boundingBox())!.height)).toBe(480);
    // Resizing didn't open the board.
    await expect(page).toHaveURL(/#\/Doc$/);
    await expectSaved(request, 'Doc', (content) => content === '![[Tall.canvas|480]]\n\nEnd');

    await page.reload();
    await expect(page.getByTestId('board-embed-frame')).toBeVisible();
    expect(Math.round((await page.getByTestId('board-embed-frame').boundingBox())!.height)).toBe(480);
  });

  test('a missing board shows "Board not found" and Create makes it', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Plans', content: '![[Someday.canvas|300]]' }]);
    await openPage(page, 'Plans');
    const missing = page.getByTestId('board-embed-missing');
    await expect(missing).toContainText('Board not found');
    await expect(page.getByTestId('board-embed-resize')).toHaveCount(0);

    await page.getByTestId('board-embed-create').click();
    const embed = page.getByTestId('board-embed');
    await expect(embed).toHaveAttribute('data-board-id', 'Plans/Someday.canvas');
    await expect(embed.getByTestId('board-preview')).toBeVisible();
    // The link still resolves (by file name), so the page keeps its text and height.
    expect((await api.getPage(request, 'Plans')).content).toBe('![[Someday.canvas|300]]');
    expect(Math.round((await page.getByTestId('board-embed-frame').boundingBox())!.height)).toBe(300);
  });

  test('dropping a board from the sidebar onto a page embeds it', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Journal', content: 'Today' }]);
    const board = await createBoard(request, 'Sketch');
    await saveBoard(request, board.meta.id, [sticky('Idea')]);
    await openPage(page, 'Journal');
    const editor = page.getByTestId('editor-content');
    const box = (await editor.boundingBox())!;
    await page.getByTestId('page-item-Sketch.canvas').dragTo(editor, { targetPosition: { x: 40, y: Math.min(box.height - 4, 30) } });
    const embed = page.getByTestId('board-embed');
    await expect(embed).toHaveAttribute('data-board-id', 'Sketch.canvas');
    await expect(embed).toContainText('Idea');
    await expectSaved(request, 'Journal', (content) => content === 'Today\n\n![[Sketch.canvas]]');
  });

  test('renaming the board rewrites the embed and keeps its height (D12)', async ({ page, request, vault }) => {
    const board = await createBoard(request, 'Map');
    await saveBoard(request, board.meta.id, [sticky('Pin')]);
    await vault.seed([{ title: 'Trip', content: 'Route\n\n![[Map.canvas|420]]' }]);

    const response = await request.put(`/api/boards/${encodeURIComponent('Map.canvas')}`, { data: { title: 'Route map' } });
    expect(response.ok()).toBe(true);
    expect((await api.getPage(request, 'Trip')).content).toBe('Route\n\n![[Route map.canvas|420]]');

    await openPage(page, 'Trip');
    const embed = page.getByTestId('board-embed');
    await expect(embed).toHaveAttribute('data-board-id', 'Route map.canvas');
    await expect(embed).toContainText('Pin');
  });

  test('a page embedding a board that holds a card of that page never loops', async ({ page, request, vault }) => {
    const board = await createBoard(request, 'Loop');
    await vault.seed([{ title: 'Home', content: 'Hello\n\n![[Loop.canvas]]' }]);
    await saveBoard(request, board.meta.id, [
      { id: nodeId(), type: 'file', file: 'Home.md', x: 0, y: 0, width: 360, height: 220 },
      sticky('Also [[Home]]', 420, 0),
    ]);
    await openPage(page, 'Home');
    const embed = page.getByTestId('board-embed');
    await expect(embed.getByTestId('board-page-card')).toContainText('Home');
    // The card shows the page as text; it never renders the page's embed again.
    await expect(page.getByTestId('board-embed')).toHaveCount(1);
    await expect(page.getByTestId('board-preview')).toHaveCount(1);
  });
});

test.describe('embed performance', () => {
  test('a page with a 1000-object board embedded scrolls smoothly', async ({ page, request, vault }, testInfo) => {
    test.setTimeout(90_000);
    const board = await createBoard(request, 'Big');
    const nodes: BoardNode[] = [];
    for (let i = 0; i < 1000; i += 1) {
      nodes.push({ ...sticky(`Note ${i} with a few words`, (i % 40) * 240, Math.floor(i / 40) * 240), width: 200, height: 200 });
    }
    await saveBoard(request, board.meta.id, nodes);
    const filler = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}: some text to scroll past.`).join('\n\n');
    await vault.seed([{ title: 'Long', content: `${filler}\n\n![[Big.canvas|480]]\n\n${filler}` }]);

    await openPage(page, 'Long');
    const embed = page.getByTestId('board-embed');

    /** Scroll the page column by `steps` × `delta` px, one step a frame; time every frame. */
    const scrollFrames = (steps: number, delta: number, back: boolean) =>
      page.evaluate(
        async ({ steps, delta, back }) => {
          let scroller: HTMLElement | null = document.querySelector<HTMLElement>('[data-testid="board-embed"]');
          while (scroller && !(scroller.scrollHeight > scroller.clientHeight && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) {
            scroller = scroller.parentElement;
          }
          const target: HTMLElement | Window = scroller ?? window;
          const frames: number[] = [];
          let last = performance.now();
          let running = true;
          const tick = (now: number) => {
            frames.push(now - last);
            last = now;
            if (running) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          for (let step = 0; step < steps; step += 1) {
            target.scrollBy(0, back && step >= steps / 2 ? -delta : delta);
            await new Promise((resolve) => requestAnimationFrame(resolve));
          }
          running = false;
          frames.shift();
          const sorted = [...frames].sort((a, b) => a - b);
          const avg = frames.reduce((sum, value) => sum + value, 0) / frames.length;
          return { frames: frames.length, avg, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 };
        },
        { steps, delta, back },
      );
    const format = (r: { frames: number; avg: number; p95: number; max: number }) =>
      `${r.frames} frames: avg ${r.avg.toFixed(1)} ms, p95 ${r.p95.toFixed(1)} ms, max ${r.max.toFixed(1)} ms`;

    // Budgets scale with how busy the machine is right now (#eiyrbvgx,
    // e2e/support/perf.ts). Mounting the board in chunks keeps the cold scroll
    // free of long hitches. Cold can only be measured once.
    const cold = await measure(testInfo, 'cold scroll', () => scrollFrames(160, 24, false), (r) => [
      [r.max, 150, 'cold scroll longest frame ms'],
    ]);
    console.log(`[embed-perf] cold scroll onto a 1000-object embed, ${format(cold)}`);
    await embed.scrollIntoViewIfNeeded();
    await expect(embed.getByTestId('board-preview')).toHaveAttribute('data-nodes', '1000', { timeout: 20_000 });
    await expect(embed.locator('.react-flow__node')).toHaveCount(1000, { timeout: 20_000 });
    // Fitted far out, the text is drawn at its lowest level of detail.
    await expect(embed.getByTestId('board-preview')).toHaveAttribute('data-lod', /^[1-5]$/);

    // Warm: up and down over the mounted embed.
    // 60 fps is 16.7 ms a frame; the base numbers leave headroom for the dev
    // build (React dev mode is ~2× slower than production) on a quiet machine.
    const result = await measure(testInfo, 'warm scroll', () => scrollFrames(120, 24, true), (r) => [
      [r.avg, 20, 'warm scroll avg frame ms'],
      [r.p95, 34, 'warm scroll p95 frame ms'],
    ], { attempts: 2 });
    console.log(`[embed-perf] warm scroll over a 1000-object embed, ${format(result)}`);
  });
});
