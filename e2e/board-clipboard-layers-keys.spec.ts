import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * #sdwrzdgx (board hunt P2 1–3, report/board-hunt-2026-11), in the board lab:
 * 1. a board copy is readable text outside boards, and still a board copy inside one;
 * 2. arrows (and their labels) inside a frame are drawn over its fill, also in an export;
 * 3. Enter on a focused toolbar button presses it instead of editing the selected object.
 */

interface NodeLike {
  id: string;
  type: string;
  text?: string;
  file?: string;
  gumply?: { kind: string };
}
interface BoardLike {
  nodes: NodeLike[];
  edges: unknown[];
}

const board = (page: Page): Promise<BoardLike> => page.evaluate(() => (window as unknown as { __board: { get(): BoardLike } }).__board.get());

async function openLab(page: Page, options: { theme?: 'light' | 'dark'; reset?: boolean } = {}) {
  const params = new URLSearchParams({ theme: options.theme ?? 'light' });
  if (options.reset !== false) params.set('reset', '1');
  await page.goto(`/board-lab.html?${params.toString()}`);
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

/** An Obsidian-style canvas: a group holding two cards joined by a labelled arrow. */
const GROUPED = {
  nodes: [
    { id: 'g1', type: 'group', label: 'Spring beds', x: 0, y: 0, width: 760, height: 360, color: '4' },
    { id: 't1', type: 'text', text: 'Peas', x: 40, y: 60, width: 200, height: 120 },
    { id: 't2', type: 'text', text: 'Beans', x: 500, y: 60, width: 200, height: 120 },
  ],
  edges: [{ id: 'e1', fromNode: 't1', fromSide: 'right', toNode: 't2', toSide: 'left', label: 'then', toEnd: 'arrow' }],
};

async function openGrouped(page: Page, theme: 'light' | 'dark' = 'light') {
  await page.goto('/board-lab.html?reset=1');
  await page.evaluate((json) => window.localStorage.setItem('gumply:board-lab:lab', json), JSON.stringify(GROUPED));
  await openLab(page, { reset: false, theme });
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.getByTestId('board-fit').click();
}

/** What is painted at the middle of the arrow and at its label. */
async function topmost(page: Page) {
  return page.evaluate(() => {
    const path = document.querySelector<SVGPathElement>('.react-flow__edge path.board-edge-path');
    const label = document.querySelector<HTMLElement>('[data-testid="board-edge-label"]');
    if (!path || !label) return null;
    const middle = path.getPointAtLength(path.getTotalLength() / 2);
    const matrix = path.getScreenCTM();
    if (!matrix) return null;
    const point = new DOMPoint(middle.x, middle.y).matrixTransform(matrix);
    const box = label.getBoundingClientRect();
    const at = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y);
      if (element?.closest('[data-testid="board-edge-label"]')) return 'label';
      if (element?.closest('.react-flow__edge')) return 'edge';
      if (element?.closest('.react-flow__node')) return `node:${element.closest<HTMLElement>('.react-flow__node')?.dataset.id}`;
      return element?.className.toString() ?? 'none';
    };
    // Beside the label, on the line: the label sits on the middle of a long arrow.
    return { line: at(point.x - box.width, point.y), label: at(box.x + box.width / 2, box.y + box.height / 2) };
  });
}

test.describe('board P2s from the hunt (#sdwrzdgx)', () => {
  test('a copy is readable text outside boards and still a board copy inside one', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLab(page);
    await page.getByTestId('board-tool-page').click();
    await page.getByTestId('board-page-picker-input').fill('q1');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-card-page')).toContainText('Q1 plan');
    await addSticky(page, 380, 200, 'Flour');
    await addSticky(page, 1000, 200, 'Rice');

    await page.getByTestId('board-sticky').first().click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).not.toContain('gumply-board-clipboard');
    // Reading order: the two stickies' row first, then the page card below them.
    expect(text).toBe('Flour\nRice\n[[Q1 plan]]');

    // Into a board: the same objects, kinds kept (stickies stay stickies, the card a card).
    await page.mouse.move(640, 650);
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await board(page)).nodes.length).toBe(6);
    const saved = await board(page);
    expect(saved.nodes.filter((node) => node.gumply?.kind === 'sticky').map((node) => node.text).sort()).toEqual(['Flour', 'Flour', 'Rice', 'Rice']);
    expect(saved.nodes.filter((node) => node.type === 'file').map((node) => node.file)).toEqual(['Projects/Q1 plan.md', 'Projects/Q1 plan.md']);

    // Into anything else (a plain field here): the readable text.
    await page.evaluate(() => {
      const field = document.createElement('textarea');
      field.dataset.testid = 'outside-field';
      Object.assign(field.style, { position: 'fixed', top: '0', left: '0', zIndex: '9999' });
      document.body.append(field);
    });
    await page.getByTestId('outside-field').focus();
    await page.keyboard.press('Control+v');
    await expect(page.getByTestId('outside-field')).toHaveValue('Flour\nRice\n[[Q1 plan]]');
  });

  test('a copy made before the change (JSON as text) still pastes as objects', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openLab(page);
    const legacy = JSON.stringify({
      'gumply-board-clipboard': 1,
      nodes: [{ id: 'old1', type: 'text', text: 'Old copy', gumply: { kind: 'sticky' }, x: 0, y: 0, width: 200, height: 200, color: '3' }],
      edges: [],
    });
    await page.evaluate((value) => navigator.clipboard.writeText(value), legacy);
    await page.getByTestId('board').focus();
    await page.mouse.move(640, 400);
    await page.keyboard.press('Control+v');
    await expect.poll(async () => (await board(page)).nodes.map((node) => [node.text, node.gumply?.kind])).toEqual([['Old copy', 'sticky']]);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`arrows and their labels inside a frame are drawn over its fill (${theme})`, async ({ page }, info) => {
      await openGrouped(page, theme);
      await expect.poll(() => topmost(page)).toEqual({ line: 'edge', label: 'label' });
      // Still under the cards: the cards' centres are the cards.
      for (const id of ['t1', 't2']) {
        const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
        if (!box) throw new Error(`no box for ${id}`);
        const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest<HTMLElement>('.react-flow__node')?.dataset.id, [box.x + box.width / 2, box.y + box.height / 2]);
        expect(hit).toBe(id);
      }
      await page.screenshot({ path: info.outputPath(`frame-arrow-${theme}.png`) });
    });
  }

  test('an SVG export paints the arrow and its label after the frame', async ({ page }) => {
    await openGrouped(page);
    await page.getByTestId('board-menu-button').click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('board-export-svg').click()]);
    const path = await download.path();
    if (!path) throw new Error('download failed');
    const svg = readFileSync(path, 'utf8');
    const frameName = svg.indexOf('>Spring beds<');
    const label = svg.indexOf('>then<');
    expect(frameName).toBeGreaterThan(-1);
    expect(label).toBeGreaterThan(frameName);
  });

  test('Enter on a focused toolbar button chooses the tool; Enter on the object still edits it', async ({ page }) => {
    await openLab(page);
    await addSticky(page, 500, 400, 'Rice');
    await page.getByTestId('board-sticky').first().click();
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    await page.getByTestId('board-tool-text').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-tool-text')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
    await page.getByTestId('board-tool-select').focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('board-tool-select')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
    // A colour button with a sticky selected: Enter recolours, no editor.
    await page.getByTestId('board-sticky').first().click();
    await page.getByTestId('board-color-1').focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await board(page)).nodes[0] as unknown as { color?: string }).toMatchObject({ color: '1' });
    await expect(page.getByTestId('board-text-editor')).toHaveCount(0);
    expect((await board(page)).nodes[0]?.text).toBe('Rice');

    // On the object itself, Enter still opens its editor.
    await page.locator('.react-flow__node').first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('board-text-editor')).toBeFocused();
  });
});
