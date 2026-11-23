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
    // W2b renders sticky text as Markdown: `[[Roadmap]]` shows as a link.
    await expect(page.getByTestId('board-sticky')).toContainText('Hello Roadmap');
    await expect(page.getByTestId('board-sticky').locator('wiki-link')).toHaveText('Roadmap');

    const saved = await board(page);
    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]).toMatchObject({ type: 'text', text: 'Hello [[Roadmap]]', color: '3', gumply: { kind: 'sticky' } });

    await openLab(page, { reset: false });
    await expect(page.getByTestId('board-sticky').locator('wiki-link')).toHaveText('Roadmap');
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
    // The Text tool marks its nodes (#jchhjepb): unmarked text is an Obsidian card.
    expect(text).toMatch(/"text":"Plain text",\n\t\t\t"gumply":\{"kind":"text"\},\n\t\t\t"x":/);
  });

  test('a new frame is named right away; typing never triggers tool shortcuts', async ({ page }) => {
    await openLab(page);
    await page.keyboard.press('f');
    await drag(page, { x: 300, y: 250 }, { x: 700, y: 550 });
    await expect(page.getByTestId('board-frame-input')).toBeFocused();
    // P, h and s would switch to Pen, Hand and Shape if they reached the board.
    await page.keyboard.type('Phase 1 shapes');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-frame')).toContainText('Phase 1 shapes');
    await expect(page.getByTestId('board-tool-select')).toHaveAttribute('aria-pressed', 'true');
    expect((await board(page)).nodes[0]).toMatchObject({ type: 'group', label: 'Phase 1 shapes' });
    // Drawing and naming the frame is one undo step.
    await page.keyboard.press('Control+z');
    expect((await board(page)).nodes).toHaveLength(0);
  });

  test('link cards open only http(s)/mailto URLs (a javascript: card is inert)', async ({ page }) => {
    const unsafe = {
      nodes: [
        { id: 'bad0000000000001', type: 'link', url: 'javascript:window.__pwned=1', x: 0, y: 0, width: 300, height: 160 },
        { id: 'good000000000001', type: 'link', url: 'https://jsoncanvas.org', x: 400, y: 0, width: 300, height: 160 },
      ],
      edges: [],
    };
    await page.addInitScript((value) => {
      window.localStorage.setItem('gumply:board-lab:links', value);
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((url?: string | URL) => {
        (window as unknown as { __opened: string[] }).__opened.push(String(url));
        return null;
      }) as typeof window.open;
    }, JSON.stringify(unsafe));
    await page.goto('/board-lab.html?id=links&theme=light');
    const cards = page.getByTestId('board-card-link');
    await expect(cards).toHaveCount(2);
    // The unsafe card shows its URL as text and has no Open button.
    await expect(cards.first()).toContainText('javascript:window.__pwned=1');
    await expect(cards.first().getByTestId('board-card-open')).toHaveCount(0);
    await cards.first().dblclick();
    await cards.nth(1).dblclick();
    const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
    expect(opened).toEqual(['https://jsoncanvas.org/']);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
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

  test('the Connector tool connects objects by dragging from anywhere on them, or click then click (#r3d9ft49)', async ({ page }) => {
    await openLab(page);
    await addSticky(page, 300, 300, 'A');
    await addSticky(page, 700, 300, 'B');
    await addSticky(page, 500, 600, 'C');
    const before = await board(page);
    const [a, b, c] = before.nodes;

    await page.keyboard.press('c');
    await expect(page.getByTestId('board-tool-connector')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('board-connector-hint')).toHaveText('Drag from one object to another');

    // Centre of A to centre of B: one connector, sides snapped, A doesn't move.
    const boxA = await centre(page, 'board-sticky', 0);
    const boxB = await centre(page, 'board-sticky', 1);
    const boxC = await centre(page, 'board-sticky', 2);
    await drag(page, boxA, boxB);
    let saved = await board(page);
    expect(saved.edges).toHaveLength(1);
    expect(saved.edges[0]).toMatchObject({ fromNode: a?.id, fromSide: 'right', toNode: b?.id, toSide: 'left' });
    expect(saved.nodes.map((node) => [node.x, node.y])).toEqual(before.nodes.map((node) => [node.x, node.y]));

    // Edge of B to edge of C works the same.
    await drag(page, { x: boxB.box.x + 6, y: boxB.box.y + boxB.box.height - 6 }, { x: boxC.box.x + boxC.box.width - 6, y: boxC.box.y + 6 });
    saved = await board(page);
    expect(saved.edges).toHaveLength(2);
    expect(saved.edges[1]).toMatchObject({ fromNode: b?.id, toNode: c?.id });

    // Click then click: C → A.
    await page.mouse.click(boxC.x, boxC.y);
    await expect(page.getByTestId('board-link-from')).toBeVisible();
    await page.mouse.click(boxA.x, boxA.y);
    saved = await board(page);
    expect(saved.edges).toHaveLength(3);
    expect(saved.edges[2]).toMatchObject({ fromNode: c?.id, toNode: a?.id });

    // A drop on empty canvas makes nothing.
    await drag(page, boxA, { x: 1100, y: 700 });
    expect((await board(page)).edges).toHaveLength(3);
    // Still the connector tool; objects never moved.
    await expect(page.getByTestId('board-tool-connector')).toHaveAttribute('aria-pressed', 'true');
    expect((await board(page)).nodes.map((node) => [node.x, node.y])).toEqual(before.nodes.map((node) => [node.x, node.y]));

    // The hint is shown once.
    await page.keyboard.press('v');
    await page.keyboard.press('c');
    await expect(page.getByTestId('board-connector-hint')).toHaveCount(0);
  });

  test('a label on a short connector sits beside it, not over the arrow (#xq6zas7v)', async ({ page }) => {
    const seed = {
      nodes: [
        { id: 'aaaa000000000001', type: 'text', text: 'A', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 200, height: 200, color: '3' },
        { id: 'aaaa000000000002', type: 'text', text: 'B', gumply: { kind: 'sticky' }, x: 270, y: 0, width: 200, height: 200, color: '3' },
        { id: 'aaaa000000000003', type: 'text', text: 'C', gumply: { kind: 'sticky' }, x: 1000, y: 0, width: 200, height: 200, color: '3' },
      ],
      edges: [
        { id: 'eeee000000000001', fromNode: 'aaaa000000000001', fromSide: 'right', toNode: 'aaaa000000000002', toSide: 'left', label: 'read next' },
        { id: 'eeee000000000002', fromNode: 'aaaa000000000002', fromSide: 'right', toNode: 'aaaa000000000003', toSide: 'left', label: 'then this' },
      ],
    };
    await page.addInitScript((value) => window.localStorage.setItem('gumply:board-lab:labels', value), JSON.stringify(seed));
    await page.goto('/board-lab.html?id=labels&theme=light');
    const labels = page.getByTestId('board-edge-label');
    await expect(labels).toHaveCount(2);
    await expect(labels.filter({ hasText: 'read next' })).toHaveAttribute('data-placement', 'above');
    await expect(labels.filter({ hasText: 'then this' })).toHaveAttribute('data-placement', 'center');

    // Rendered: the short arrow's line is uncovered (the label ends above it).
    const short = await labels.filter({ hasText: 'read next' }).boundingBox();
    const line = await page.locator('.react-flow__edge').first().locator('.board-edge-path').boundingBox();
    if (!short || !line) throw new Error('no layout');
    expect(short.y + short.height).toBeLessThanOrEqual(line.y + 1);
  });

  test('zoomed far out (15%), dots and resize handles stay >= 10 px and still work (#zk6etvae)', async ({ page }) => {
    const seed = {
      nodes: [
        { id: 'zzzz000000000001', type: 'text', text: 'A', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 400, height: 400, color: '3' },
        { id: 'zzzz000000000002', type: 'text', text: 'B', gumply: { kind: 'sticky' }, x: 1400, y: 0, width: 400, height: 400, color: '3' },
      ],
      edges: [],
    };
    await page.addInitScript((value) => {
      window.localStorage.setItem('gumply:board-lab:far', value);
      // The remembered view: 15% zoom, board near the top-left.
      window.localStorage.setItem('gumply:board-view:lab:far', JSON.stringify({ x: 400, y: 250, zoom: 0.15 }));
    }, JSON.stringify(seed));
    await page.goto('/board-lab.html?id=far&theme=light');
    await expect(page.getByTestId('board-zoom-value')).toHaveText('15%');

    const a = page.getByTestId('board-sticky').first();
    await a.hover();
    const dot = await a.locator('xpath=..').getByTestId('board-handle-right').boundingBox();
    if (!dot) throw new Error('no dot');
    expect(dot.width).toBeGreaterThanOrEqual(10);
    expect(dot.height).toBeGreaterThanOrEqual(10);

    // A connector from the dot to B.
    const b = await centre(page, 'board-sticky', 1);
    await drag(page, { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 }, b);
    expect((await board(page)).edges).toHaveLength(1);

    // Select A: its resize handle is 10-14 px on screen (not compensated twice) and resizes.
    await a.click();
    const handle = page.locator('.react-flow__resize-control.handle.bottom.right');
    const box = await handle.boundingBox();
    if (!box) throw new Error('no resize handle');
    expect(box.width).toBeGreaterThanOrEqual(10);
    expect(box.width).toBeLessThanOrEqual(14);
    expect(dot.width).toBeLessThanOrEqual(14);
    const before = (await board(page)).nodes[0]?.width ?? 0;
    await drag(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 + 30, y: box.y + box.height / 2 + 30 });
    expect(((await board(page)).nodes[0]?.width ?? 0) - before).toBeGreaterThan(100);
  });

  test('connection dots stay ~11 px at 10% and 200%: hovered, selected, with the connector tool and after a zoom (#zkknytrs)', async ({ page }) => {
    // About 60 px on screen at either zoom, so a visible 11 px dot never covers an object's middle.
    const seedAt = (zoom: number) => {
      const size = Math.round(60 / zoom);
      return {
        nodes: [
          { id: 'dddd000000000001', type: 'text', text: 'A', gumply: { kind: 'sticky' }, x: 0, y: 0, width: size, height: size, color: '3' },
          { id: 'dddd000000000002', type: 'text', text: 'B', gumply: { kind: 'sticky' }, x: size * 3, y: 0, width: size, height: size, color: '3' },
        ],
        edges: [],
      };
    };
    const dotWidth = async (index: number) => {
      const box = await page.getByTestId('board-sticky').nth(index).locator('xpath=..').getByTestId('board-handle-right').boundingBox();
      if (!box) throw new Error('no dot');
      return box.width;
    };
    const expectDot = async (index: number) => {
      await expect.poll(() => dotWidth(index)).toBeGreaterThanOrEqual(10);
      await expect.poll(() => dotWidth(index)).toBeLessThanOrEqual(12.5);
    };

    for (const zoom of [0.1, 2]) {
      await page.addInitScript(
        ({ value, z }) => {
          window.localStorage.setItem('gumply:board-lab:dots', value);
          window.localStorage.setItem('gumply:board-view:lab:dots', JSON.stringify({ x: 300, y: 250, zoom: z }));
        },
        { value: JSON.stringify(seedAt(zoom)), z: zoom },
      );
      await page.goto('/board-lab.html?id=dots&theme=light');
      await expect(page.getByTestId('board-zoom-value')).toHaveText(`${Math.round(zoom * 100)}%`);

      // Hovered.
      await page.getByTestId('board-sticky').first().hover();
      await expectDot(0);
      // Selected, with the pointer away from it.
      await page.getByTestId('board-sticky').first().click();
      await page.mouse.move(900, 550); // empty board, clear of the zoom panel
      await expectDot(0);
      // Selected, after a Ctrl+wheel zoom (the step and the rest after it place it again).
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, zoom < 1 ? -100 : 100);
      await page.keyboard.up('Control');
      await expect(page.getByTestId('board-zoom-value')).not.toHaveText(`${Math.round(zoom * 100)}%`);
      await expectDot(0);
      // Dragging a connection from A's dot: B's dots, under the pointer mid-drag.
      await page.keyboard.press('Escape');
      await page.getByTestId('board-sticky').first().hover();
      const from = await page.getByTestId('board-sticky').first().locator('xpath=..').getByTestId('board-handle-right').boundingBox();
      const to = await page.getByTestId('board-sticky').nth(1).boundingBox();
      if (!from || !to) throw new Error('no layout');
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 8; i += 1) {
        await page.mouse.move(from.x + ((to.x + to.width / 2 - from.x) * i) / 8, from.y + ((to.y + to.height / 2 - from.y) * i) / 8);
      }
      await expectDot(1);
      await page.mouse.up();
      // The connector tool shows every dot: B, neither hovered nor selected.
      await page.keyboard.press('Escape');
      await page.getByTestId('board-tool-connector').click();
      await page.mouse.move(900, 550); // empty board, clear of the zoom panel
      await expectDot(1);
      // Leaving it takes the value off the board again.
      await page.getByTestId('board-tool-select').click();
      await expect
        .poll(() => page.getByTestId('board').evaluate((root) => (root as HTMLElement).style.getPropertyValue('--board-zoom')))
        .toBe('');
    }
  });

  test('handle sizes stay 10-14 px at 100% and 15%; a small selected card at 15% drags, never resizes (#ubqp5r4h)', async ({ page }) => {
    const seed = {
      nodes: [
        { id: 'cccc000000000001', type: 'text', text: 'Card', x: 0, y: 0, width: 260, height: 120 },
        { id: 'cccc000000000002', type: 'text', text: 'Other', x: 600, y: 0, width: 260, height: 120 },
      ],
      edges: [],
    };
    const open = async (zoom: number) => {
      await page.addInitScript(
        ({ value, z }) => {
          window.localStorage.setItem('gumply:board-lab:small', value);
          window.localStorage.setItem('gumply:board-view:lab:small', JSON.stringify({ x: 500, y: 300, zoom: z }));
        },
        { value: JSON.stringify(seed), z: zoom },
      );
      await page.goto('/board-lab.html?id=small&theme=light');
      await expect(page.getByTestId('board-zoom-value')).toHaveText(`${Math.round(zoom * 100)}%`);
    };
    const handleSize = async () => {
      await page.getByTestId('board-text').first().click();
      const box = await page.locator('.react-flow__resize-control.handle.bottom.right').boundingBox();
      if (!box) throw new Error('no resize handle');
      return box;
    };

    await open(1);
    const at100 = await handleSize();
    expect(at100.width).toBeGreaterThanOrEqual(10);
    expect(at100.width).toBeLessThanOrEqual(14);

    await open(0.15);
    const at15 = await handleSize();
    expect(at15.width).toBeGreaterThanOrEqual(10);
    expect(at15.width).toBeLessThanOrEqual(14);

    // Drag the selected 39x18 px card by a point a quarter in from its top-left corner: it moves.
    const card = await page.getByTestId('board-text').first().boundingBox();
    if (!card) throw new Error('no card');
    const before = (await board(page)).nodes[0];
    const from = { x: card.x + card.width / 4, y: card.y + card.height / 4 };
    await drag(page, from, { x: from.x + 60, y: from.y + 40 });
    const after = (await board(page)).nodes[0];
    expect([after?.width, after?.height]).toEqual([before?.width, before?.height]);
    expect((after?.x ?? 0) - (before?.x ?? 0)).toBeGreaterThan(200);
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
    // The move lands a moment after mouseup under load: wait for it (#9a393rp5).
    await expect.poll(async () => Math.abs(((await board(page)).nodes.find((node) => node.id === frame.id)?.x ?? frame.x) - frame.x)).toBeGreaterThan(50);
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
    // #pujmbsyz: 8 px, Shift 40. Wait for both presses to land (#9a393rp5).
    const position = async (id: string) => {
      const node = (await board(page)).nodes.find((item) => item.id === id);
      return { x: node?.x, y: node?.y };
    };
    await expect.poll(() => position(frame.id)).toEqual({ x: (frameAfter?.x ?? 0) + 8, y: (frameAfter?.y ?? 0) + 40 });
    await expect.poll(() => position(inside.id)).toEqual({ x: (insideAfter?.x ?? 0) + 8, y: (insideAfter?.y ?? 0) + 40 });
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
  // "Saved" is already showing from the first save, so wait for the file itself.
  await page.getByTestId('board-color-5').click();
  const read = async () => ((await (await request.get(`/api/boards/${encodeURIComponent(meta.id)}`)).json()) as { board: BoardLike }).board;
  await expect.poll(async () => (await read()).nodes[0]?.color, { timeout: 10_000 }).toBe('5');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');

  const loaded = { board: await read() };
  expect(loaded.board.nodes).toHaveLength(1);
  expect(loaded.board.nodes[0]).toMatchObject({ text: 'Saved for real [[Welcome]]', color: '5', gumply: { kind: 'sticky' } });

  // On disk: Obsidian's layout (tabs, no trailing newline).
  const file = readFileSync(path.join(E2E_VAULT, 'Engine check.canvas'), 'utf8');
  expect(file.startsWith('{\n\t"nodes":[\n')).toBe(true);
  expect(file.endsWith('}')).toBe(true);
  expect(file).toContain('"gumply":{"kind":"sticky"}');
});
