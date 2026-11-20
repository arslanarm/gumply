import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { test as vaultTest } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * Whiteboard engine (W1, #cq6wyr46, spec/whiteboard §3), driven through the
 * board lab (`/board-lab.html`): the engine without the app shell, so these
 * specs don't depend on the boards API. The lab keeps the board in
 * localStorage and exposes it as `window.__board`.
 */

interface CanvasNodeLike {
  id: string;
  type: string;
  text?: string;
  label?: string;
  file?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: string;
  gumply?: { kind: string; shape?: string; points?: number[][] };
}

interface CanvasEdgeLike {
  id: string;
  fromNode: string;
  fromSide?: string;
  toNode: string;
  toSide?: string;
  toEnd?: string;
  label?: string;
}

interface BoardLike {
  nodes: CanvasNodeLike[];
  edges: CanvasEdgeLike[];
}

async function openLab(page: Page, options: { theme?: 'light' | 'dark'; reset?: boolean } = {}) {
  const params = new URLSearchParams({ theme: options.theme ?? 'light' });
  if (options.reset !== false) params.set('reset', '1');
  await page.goto(`/board-lab.html?${params.toString()}`);
  await expect(page.getByTestId('board')).toBeVisible();
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
}

const board = (page: Page): Promise<BoardLike> => page.evaluate(() => (window as unknown as { __board: { get(): BoardLike } }).__board.get());
const serialized = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as { __board: { serialized(): string } }).__board.serialized());

function kindOf(node: CanvasNodeLike): string {
  return node.gumply?.kind ?? node.type;
}

async function addSticky(page: Page, x: number, y: number, text: string) {
  await page.mouse.dblclick(x, y);
  await expect(page.getByTestId('board-text-editor')).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
}

/** Drag from one point to another in small steps, like a real mouse. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
}

async function centre(page: Page, testId: string, index = 0) {
  const box = await page.getByTestId(testId).nth(index).boundingBox();
  if (!box) throw new Error(`no box for ${testId}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}

test.describe('board engine (W1)', () => {
  test('empty board explains itself; double-click adds a sticky that survives a reload', async ({ page }) => {
    await openLab(page);
    await expect(page.getByTestId('board-empty')).toContainText('Double-click to add a sticky note');

    await addSticky(page, 600, 400, 'Hello [[Roadmap]]');
    await expect(page.getByTestId('board-empty')).toHaveCount(0);
    await expect(page.getByTestId('board-sticky')).toContainText('Hello [[Roadmap]]');

    const saved = await board(page);
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]).toMatchObject({ type: 'text', text: 'Hello [[Roadmap]]', color: '3', gumply: { kind: 'sticky' } });

    await openLab(page, { reset: false });
    await expect(page.getByTestId('board-sticky')).toContainText('Hello [[Roadmap]]');
  });

  test('tools create stickies, text, shapes and frames in Obsidian-compatible JSON', async ({ page }) => {
    await openLab(page);

    await page.keyboard.press('n');
    await expect(page.getByTestId('board-tool-sticky')).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.click(400, 300);
    await page.keyboard.type('Sticky');
    await page.keyboard.press('Escape');
    // Placing an object returns to Select, like Miro.
    await expect(page.getByTestId('board-tool-select')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('t');
    await page.mouse.click(700, 300);
    await page.keyboard.type('Plain text');
    await page.keyboard.press('Escape');

    await page.keyboard.press('s');
    await expect(page.getByTestId('board-shape-menu')).toBeVisible();
    await page.getByTestId('board-shape-diamond').click();
    await page.mouse.click(1000, 300);
    await page.keyboard.type('Decide');
    await page.keyboard.press('Escape');

    await page.keyboard.press('f');
    await drag(page, { x: 250, y: 500 }, { x: 650, y: 750 });

    const saved = await board(page);
    expect(saved.nodes.map(kindOf)).toEqual(['sticky', 'text', 'shape', 'group']);
    expect(saved.nodes[2]?.gumply).toEqual({ kind: 'shape', shape: 'diamond' });
    expect(saved.nodes[3]).toMatchObject({ type: 'group', label: 'Frame', width: 400, height: 250 });
    for (const node of saved.nodes) {
      for (const key of ['x', 'y', 'width', 'height'] as const) expect(Number.isInteger(node[key])).toBe(true);
    }

    // Obsidian's writer: one-line nodes, gumply keys before geometry, tabs.
    const text = await serialized(page);
    expect(text.startsWith('{\n\t"nodes":[\n')).toBe(true);
    expect(text).toMatch(/"text":"Sticky",\n\t\t\t"gumply":\{"kind":"sticky"\},\n\t\t\t"x":/);
    expect(text).toContain('"text":"Plain text","x":');
  });

  test('connectors snap to the nearest side, carry a label and follow moved objects', async ({ page }) => {
    await openLab(page);
    await addSticky(page, 400, 350, 'From');
    await addSticky(page, 900, 380, 'To');

    // Drag from the right dot of "From" onto the body of "To".
    const from = page.getByTestId('board-sticky').first();
    await from.hover();
    const handle = from.locator('xpath=..').getByTestId('board-handle-right');
    const dot = await handle.boundingBox();
    if (!dot) throw new Error('no handle');
    const target = await centre(page, 'board-sticky', 1);
    await drag(page, { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }, target);

    let saved = await board(page);
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({ fromNode: saved.nodes[0]?.id, fromSide: 'right', toNode: saved.nodes[1]?.id, toSide: 'left' });
    await expect(page.getByTestId('board-edge')).toHaveCount(1);

    // Double-click the line to label it.
    await page.keyboard.press('Escape');
    const edgeBox = await page.locator('.react-flow__edge').first().boundingBox();
    if (!edgeBox) throw new Error('no edge');
    await page.mouse.dblclick(edgeBox.x + edgeBox.width / 2, edgeBox.y + edgeBox.height / 2);
    await page.getByTestId('board-edge-input').fill('next');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-edge-label')).toHaveText('next');

    // Selected connector: switch the arrow off.
    await page.getByTestId('board-edge-label').click();
    await page.getByTestId('board-edge-line').click();
    saved = await board(page);
    expect(saved.edges[0]).toMatchObject({ label: 'next', toEnd: 'none' });

    // Move "To"; the connector's end follows.
    const before = await page.locator('.react-flow__edge path.board-edge-path').first().getAttribute('d');
    const to = await centre(page, 'board-sticky', 1);
    await drag(page, to, { x: to.x + 40, y: to.y + 120 });
    await expect.poll(() => page.locator('.react-flow__edge path.board-edge-path').first().getAttribute('d')).not.toBe(before);

    // Dropping a connector on empty space cancels it.
    await from.hover();
    const dot2 = await handle.boundingBox();
    if (!dot2) throw new Error('no handle');
    await drag(page, { x: dot2.x + dot2.width / 2, y: dot2.y + dot2.height / 2 }, { x: 650, y: 750 });
    expect((await board(page)).edges).toHaveLength(1);
  });

  test('frames carry what is inside them; arrow keys nudge', async ({ page }) => {
    await openLab(page);
    await page.keyboard.press('f');
    await drag(page, { x: 300, y: 250 }, { x: 800, y: 650 });
    await addSticky(page, 450, 420, 'Inside');
    await addSticky(page, 1050, 420, 'Outside');

    const startBoard = await board(page);
    const frame = startBoard.nodes.find((node) => node.type === 'group');
    const inside = startBoard.nodes.find((node) => node.text === 'Inside');
    const outside = startBoard.nodes.find((node) => node.text === 'Outside');
    if (!frame || !inside || !outside) throw new Error('missing nodes');
    // A frame goes behind what it contains.
    expect(startBoard.nodes[0]?.id).toBe(frame.id);

    // Drag the frame by an empty spot near its top-right corner.
    await drag(page, { x: 760, y: 280 }, { x: 860, y: 330 });
    const moved = await board(page);
    const frameAfter = moved.nodes.find((node) => node.id === frame.id);
    const insideAfter = moved.nodes.find((node) => node.id === inside.id);
    const outsideAfter = moved.nodes.find((node) => node.id === outside.id);
    const dx = (frameAfter?.x ?? 0) - frame.x;
    const dy = (frameAfter?.y ?? 0) - frame.y;
    expect(Math.abs(dx)).toBeGreaterThan(50);
    expect(insideAfter?.x).toBe(inside.x + dx);
    expect(insideAfter?.y).toBe(inside.y + dy);
    expect(outsideAfter).toEqual(outside);

    // Nudge the selected frame (and its contents) with the arrow keys.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowDown');
    const nudged = await board(page);
    expect(nudged.nodes.find((node) => node.id === frame.id)).toMatchObject({ x: (frameAfter?.x ?? 0) + 1, y: (frameAfter?.y ?? 0) + 10 });
    expect(nudged.nodes.find((node) => node.id === inside.id)).toMatchObject({ x: (insideAfter?.x ?? 0) + 1, y: (insideAfter?.y ?? 0) + 10 });
  });

  test('undo and redo cover create, move, text edits, colour and delete', async ({ page }) => {
    await openLab(page);
    await addSticky(page, 500, 400, 'First');
    const sticky = page.getByTestId('board-sticky').first();

    // Move it.
    const beforeMove = (await board(page)).nodes[0];
    const start = await centre(page, 'board-sticky');
    await drag(page, start, { x: start.x + 200, y: start.y });
    const afterMove = (await board(page)).nodes[0];

    // Edit the text (Enter on the selection starts editing).
    await page.keyboard.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.type(' draft');
    await page.keyboard.press('Escape');
    await expect(sticky).toContainText('First draft');

    // Colour, then delete with the keyboard.
    await page.getByTestId('board-color-1').click();
    expect((await board(page)).nodes[0]?.color).toBe('1');
    await page.keyboard.press('Delete');
    expect((await board(page)).nodes).toHaveLength(0);

    await page.keyboard.press('Control+z');
    expect((await board(page)).nodes[0]?.color).toBe('1');
    await page.keyboard.press('Control+z');
    expect((await board(page)).nodes[0]?.color).toBe('3');
    await page.keyboard.press('Control+z');
    await expect(sticky).toContainText('First');
    expect((await board(page)).nodes[0]?.text).toBe('First');
    await page.keyboard.press('Control+z');
    expect((await board(page)).nodes[0]?.x).toBe(beforeMove?.x);
    await page.getByTestId('board-undo').click();
    expect((await board(page)).nodes).toHaveLength(0);
    await expect(page.getByTestId('board-undo')).toBeDisabled();

    await page.keyboard.press('Control+Shift+z');
    expect((await board(page)).nodes).toHaveLength(1);
    await page.getByTestId('board-redo').click();
    expect((await board(page)).nodes[0]?.x).toBe(afterMove?.x);
  });

  test('duplicate, copy/paste and z-order', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLab(page);
    await addSticky(page, 400, 400, 'A');
    await addSticky(page, 700, 400, 'B');

    // B is selected (just created): duplicate it.
    await page.getByTestId('board-sticky').nth(1).click();
    await page.keyboard.press('Control+d');
    let saved = await board(page);
    expect(saved.nodes.map((node) => node.text)).toEqual(['A', 'B', 'B']);
    expect(saved.nodes[2]?.x).toBe((saved.nodes[1]?.x ?? 0) + 24);
    expect(saved.nodes[2]?.id).not.toBe(saved.nodes[1]?.id);

    // Copy A and paste at the pointer.
    await page.getByTestId('board-sticky').first().click();
    await page.keyboard.press('Control+c');
    await page.mouse.move(600, 700);
    await page.keyboard.press('Control+v');
    saved = await board(page);
    expect(saved.nodes.map((node) => node.text)).toEqual(['A', 'B', 'B', 'A']);
    const pasted = saved.nodes[3];
    expect(Math.abs((pasted?.x ?? 0) + (pasted?.width ?? 0) / 2 - (saved.nodes[0]?.x ?? 0) - 100)).toBeGreaterThan(50);

    // The pasted copy is selected: send it to the back.
    await page.getByTestId('board-back').click();
    saved = await board(page);
    expect(saved.nodes[0]?.id).toBe(pasted?.id);
    await page.getByTestId('board-front').click();
    expect((await board(page)).nodes.at(-1)?.id).toBe(pasted?.id);
  });

  test('resize handles, pen strokes and page cards', async ({ page }) => {
    await openLab(page);
    await page.keyboard.press('s');
    await page.getByTestId('board-shape-rect').click();
    await page.mouse.click(500, 350);
    await page.keyboard.press('Escape');
    const before = (await board(page)).nodes[0];

    // Bottom-right resize handle.
    const handle = page.locator('.react-flow__resize-control.handle.bottom.right');
    const box = await handle.boundingBox();
    if (!box) throw new Error('no resize handle');
    await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + 104, y: box.y + 54 });
    const after = (await board(page)).nodes[0];
    expect((after?.width ?? 0) - (before?.width ?? 0)).toBeGreaterThan(80);
    expect((after?.height ?? 0) - (before?.height ?? 0)).toBeGreaterThan(40);

    // Pen.
    await page.keyboard.press('p');
    await page.mouse.move(300, 600);
    await page.mouse.down();
    for (let i = 0; i <= 20; i += 1) await page.mouse.move(300 + i * 10, 600 + Math.sin(i / 3) * 25);
    await page.mouse.up();
    const ink = (await board(page)).nodes.find((node) => node.gumply?.kind === 'ink');
    expect(ink?.gumply?.points?.length).toBeGreaterThan(10);
    expect(ink?.text).toBe('');
    await expect(page.getByTestId('board-ink').locator('path')).toHaveAttribute('d', /^M/);

    // Page card from "Add page…", opened by double-click.
    await page.keyboard.press('v');
    await page.getByTestId('board-tool-page').click();
    await page.getByTestId('board-page-picker-input').fill('q1');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-card-page')).toContainText('Q1 plan');
    expect((await board(page)).nodes.at(-1)).toMatchObject({ type: 'file', file: 'Projects/Q1 plan.md' });
    await page.getByTestId('board-card-page').dblclick();
    expect(await page.evaluate(() => (window as unknown as { __board: { opened: string[] } }).__board.opened)).toEqual(['Projects/Q1 plan.md']);
  });

  test('pan and zoom: buttons, Fit (Shift+1) and Ctrl+wheel stay within 10%–400%', async ({ page }) => {
    await openLab(page);
    await addSticky(page, 640, 400, 'Zoom me');
    const value = page.getByTestId('board-zoom-value');
    await expect(value).toHaveText('100%');
    await page.getByTestId('board-zoom-in').click();
    await expect(value).not.toHaveText('100%');
    await value.click();
    await expect(value).toHaveText('100%');

    await page.mouse.move(640, 400);
    await page.keyboard.down('Control');
    for (let i = 0; i < 40; i += 1) await page.mouse.wheel(0, 120);
    await page.keyboard.up('Control');
    await expect(value).toHaveText('10%');

    await page.keyboard.press('Shift+Digit1');
    await expect(value).toHaveText('100%');

    // Trackpad-style scroll pans instead of zooming.
    const before = await centre(page, 'board-sticky');
    await page.mouse.wheel(0, 200);
    await expect.poll(async () => (await centre(page, 'board-sticky')).y).toBeLessThan(before.y - 100);
    await expect(value).toHaveText('100%');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`board paints stickies, shapes and connectors (${theme})`, async ({ page }) => {
      await openLab(page, { theme });
      await addSticky(page, 400, 380, 'Paint');
      await page.keyboard.press('s');
      await page.getByTestId('board-shape-ellipse').click();
      await page.mouse.click(900, 380);
      await page.keyboard.press('Escape');
      await page.mouse.click(1200, 750);

      const pixels = async (testId: string) => {
        const shot = await page.getByTestId(testId).first().screenshot();
        return page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          if (!context) return null;
          context.drawImage(image, 0, 0);
          // Sample a pixel near the top-left corner (inside, away from text).
          const [r, g, b] = context.getImageData(12, 12, 1, 1).data;
          return { r, g, b };
        }, shot.toString('base64'));
      };

      const sticky = await pixels('board-sticky');
      if (!sticky) throw new Error('no pixels');
      // Default sticky is yellow ("3") in both themes: red+green well above blue.
      expect(sticky.r + sticky.g - 2 * sticky.b).toBeGreaterThan(theme === 'light' ? 150 : 60);

      const surface = await page.evaluate(() => getComputedStyle(document.querySelector('[data-testid=board]') as Element).backgroundColor);
      expect(surface).toBe(theme === 'light' ? 'rgb(251, 251, 250)' : 'rgb(22, 22, 22)');

      // Connect the two and check the line actually paints between them.
      const from = page.getByTestId('board-sticky').first();
      await from.hover();
      const dot = await from.locator('xpath=..').getByTestId('board-handle-right').boundingBox();
      if (!dot) throw new Error('no handle');
      await drag(page, { x: dot.x + 5, y: dot.y + 5 }, (await centre(page, 'board-shape')));
      await page.mouse.click(1200, 750);
      const line = await page.screenshot({ clip: { x: 520, y: 360, width: 240, height: 40 } });
      const inked = await page.evaluate(async ({ base64, dark }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        if (!context) return 0;
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, image.width, image.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          const luma = 0.3 * (data[i] ?? 0) + 0.59 * (data[i + 1] ?? 0) + 0.11 * (data[i + 2] ?? 0);
          if (dark ? luma > 150 : luma < 100) count += 1;
        }
        return count;
      }, { base64: line.toString('base64'), dark: theme === 'dark' });
      expect(inked).toBeGreaterThan(100);
    });
  }
});

/**
 * BoardView: load, debounced autosave and the D22 conflict flow, against a
 * mocked `/api/boards/:id` (spec/whiteboard §2) until the server lands (W0b).
 */
test.describe('board view: autosave and conflicts', () => {
  const META = { id: 'Plans/Map', title: 'Map', tags: [], parentId: 'Plans', childCount: 0, created: '2026-11-20T10:00:00.000Z' };
  const diskBoard = {
    nodes: [{ id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'From disk', x: 0, y: 0, width: 200, height: 200, color: '3', gumply: { kind: 'sticky' } }],
    edges: [],
  };

  test('loads, autosaves with the loaded version, and resolves a conflict with Keep mine or Reload', async ({ page }) => {
    const puts: Record<string, unknown>[] = [];
    let version = 1;
    let conflictNext = false;
    let disk: typeof diskBoard = diskBoard;
    await page.route('**/api/boards/**', async (route) => {
      const request = route.request();
      expect(new URL(request.url()).pathname).toBe('/api/boards/Plans%2FMap');
      if (request.method() === 'GET') {
        // The client now has the disk version, so its next save is accepted.
        conflictNext = false;
        await route.fulfill({ json: { meta: { ...META, updated: `v${version}` }, board: disk } });
        return;
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      puts.push(body);
      if (conflictNext && !body.force) {
        await route.fulfill({ status: 409, json: { error: 'Changed on disk' } });
        return;
      }
      conflictNext = false;
      version += 1;
      disk = body.board as typeof diskBoard;
      const repair = puts.length === 1 ? { repairBackup: '.gumply/conflicts/Map.2026.canvas' } : {};
      await route.fulfill({
        json: {
          meta: { ...META, updated: `v${version}` },
          board: body.board,
          ...(body.force ? { conflictBackup: '.trash/conflicts/Map.canvas' } : {}),
          ...repair,
        },
      });
    });

    await page.goto('/board-lab.html?api=Plans%2FMap');
    await expect(page.getByTestId('board-sticky')).toContainText('From disk');

    // An edit is saved once, after the debounce, with the loaded version.
    await page.getByTestId('board-sticky').dblclick();
    await page.keyboard.press('End');
    await page.keyboard.type(' + mine');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({ expectedUpdated: 'v1' });
    expect((puts[0]?.board as typeof diskBoard).nodes[0]?.text).toBe('From disk + mine');
    // The first save of a repaired file says where the original went.
    await expect(page.getByTestId('board-repair-notice')).toContainText('.gumply/conflicts/Map.2026.canvas');
    await page.getByTestId('board-repair-notice').getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.getByTestId('board-repair-notice')).toHaveCount(0);

    // Someone else changed the file: the next save is refused → Keep mine.
    conflictNext = true;
    await page.getByTestId('board-color-1').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict');
    expect(puts.at(-1)).toMatchObject({ expectedUpdated: 'v2' });
    await page.getByTestId('conflict-keep-mine').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect(puts.at(-1)).toMatchObject({ force: true });
    expect((puts.at(-1)?.board as typeof diskBoard).nodes[0]?.color).toBe('1');

    // Another conflict, resolved with Reload: the disk version replaces the board.
    conflictNext = true;
    disk = { nodes: [{ ...diskBoard.nodes[0]!, text: 'Edited elsewhere' }], edges: [] };
    version += 1;
    await page.getByTestId('board-color-4').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict');
    await page.getByTestId('conflict-reload').click();
    await expect(page.getByTestId('board-sticky')).toContainText('Edited elsewhere');
    // Reload clears undo history (nothing of the old document to undo into).
    await expect(page.getByTestId('board-undo')).toBeDisabled();
    // Edits after a reload save against the reloaded version.
    const count = puts.length;
    await page.getByTestId('board-sticky').click();
    await page.getByTestId('board-color-2').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect(puts.length).toBe(count + 1);
    expect(puts.at(-1)).toMatchObject({ expectedUpdated: `v${version - 1}` });
  });

  test('the board engine is code-split from page startup', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(request.url());
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    expect(scripts.some((url) => /@xyflow|perfect-freehand|BoardEditor/.test(url))).toBe(false);
  });
});

/** BoardView against the real boards API (W0b, spec/api v1.7). */
vaultTest('board view saves to a real .canvas file and keeps saving after each save', async ({ page, request, vault }) => {
  void vault;
  const created = await request.post('/api/boards', { data: { title: 'Engine check' } });
  expect(created.status()).toBe(201);
  const { meta } = (await created.json()) as { meta: { id: string; kind: string } };
  expect(meta).toMatchObject({ id: 'Engine check.canvas', kind: 'whiteboard' });

  await page.goto(`/board-lab.html?api=${encodeURIComponent(meta.id)}`);
  await expect(page.getByTestId('board-empty')).toBeVisible();
  await addSticky(page, 500, 400, 'Saved for real [[Welcome]]');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  // A second edit must be accepted too (the view sends the new meta.updated).
  await page.getByTestId('board-color-5').click();
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  const loaded = (await (await request.get(`/api/boards/${encodeURIComponent(meta.id)}`)).json()) as { board: BoardLike };
  expect(loaded.board.nodes).toHaveLength(1);
  expect(loaded.board.nodes[0]).toMatchObject({ text: 'Saved for real [[Welcome]]', color: '5', gumply: { kind: 'sticky' } });

  // On disk: Obsidian's layout (tabs, no trailing newline).
  const file = readFileSync(path.join(E2E_VAULT, 'Engine check.canvas'), 'utf8');
  expect(file.startsWith('{\n\t"nodes":[\n')).toBe(true);
  expect(file.endsWith('}')).toBe(true);
  expect(file).toContain('"gumply":{"kind":"sticky"}');
});
