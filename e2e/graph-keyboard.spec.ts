import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #5n2p7phw (#62tnekds step 2): the graph canvas from the keyboard. One Tab stop; focus starts on the current page;
 * the arrows go to the nearest page that way; [ and ] step round the focused page's links; + − 0 zoom and fit;
 * Enter opens; Escape hands the keyboard back; a polite live region says where the focus is. Synthetic vault.
 */

const seed = (vault: { seed: (pages: Array<{ title: string; content?: string }>) => Promise<unknown> }) =>
  vault.seed([
    { title: 'Hub', content: 'See [[Alpha]], [[Beta]], [[Gamma]] and [[Someday]].' },
    { title: 'Alpha', content: 'Back to [[Hub]].' },
    { title: 'Beta', content: 'Back to [[Hub]].' },
    { title: 'Gamma', content: 'Nothing else.' },
  ]);

type Probe = { nodes: () => Array<{ id: string; x: number; y: number }>; zoom: () => number };
const probe = (page: Page, testId: string) =>
  page.evaluate((id) => {
    const graph = (window as unknown as { __gumplyGraphs: Record<string, Probe> }).__gumplyGraphs[id]!;
    return { nodes: graph.nodes(), zoom: graph.zoom() };
  }, testId);

/** Presses each arrow until the focus moves; the new node must lie that way on screen. */
async function arrowMoves(page: Page, testId: string) {
  const canvas = page.getByTestId(testId);
  for (const [key, check] of [
    ['ArrowRight', (a: { x: number }, b: { x: number }) => b.x > a.x],
    ['ArrowLeft', (a: { x: number }, b: { x: number }) => b.x < a.x],
    ['ArrowDown', (a: { y: number }, b: { y: number }) => b.y > a.y],
    ['ArrowUp', (a: { y: number }, b: { y: number }) => b.y < a.y],
  ] as const) {
    const before = await canvas.getAttribute('data-graph-focused');
    const nodes = (await probe(page, testId)).nodes;
    await page.keyboard.press(key);
    const after = await canvas.getAttribute('data-graph-focused');
    if (after && after !== before) {
      const from = nodes.find((node) => node.id === before)!;
      const to = nodes.find((node) => node.id === after)!;
      expect(check(from, to), `${key}: ${before} → ${after}`).toBe(true);
      return after;
    }
  }
  throw new Error('no arrow moved the focus');
}

test('#5n2p7phw: the global graph by keyboard: Tab in on the current page, arrows, [ ], zoom, Escape back, Enter opens', async ({ page, vault }) => {
  await seed(vault);
  await page.goto('/#/Hub');
  await page.getByTestId('sidebar-graph').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  await expect(canvas).toHaveAttribute('data-graph-engine', 'stopped', { timeout: 15_000 });

  // One Tab stop, after the zoom controls; focus starts on the page we came from, and it's announced.
  await page.getByTestId('graph-zoom-in').focus();
  await page.keyboard.press('Tab');
  await expect(canvas).toBeFocused();
  await expect(canvas).toHaveAttribute('data-graph-focused', 'Hub');
  await expect(page.getByTestId('graph-canvas-spoken')).toContainText('Hub');
  await expect(canvas).toHaveAccessibleDescription(/Or switch to List/);

  // ] and [ step round Hub's links, staying on Hub's ring.
  const ring = ['Alpha', 'Beta', 'Gamma', 'ghost:someday'];
  await page.keyboard.press(']');
  const first = await canvas.getAttribute('data-graph-focused');
  expect(ring).toContain(first);
  await page.keyboard.press(']');
  const second = await canvas.getAttribute('data-graph-focused');
  expect(ring).toContain(second);
  expect(second).not.toBe(first);
  await page.keyboard.press('[');
  await expect(canvas).toHaveAttribute('data-graph-focused', first!);

  // An arrow goes to a page that way on screen, and the live region names it.
  const moved = await arrowMoves(page, 'graph-canvas');
  await expect(page.getByTestId('graph-canvas-spoken')).toContainText(moved.replace('ghost:someday', 'Someday'));

  // + zooms in; 0 fits.
  const zoom = (await probe(page, 'graph-canvas')).zoom;
  await page.keyboard.press('+');
  await expect.poll(async () => (await probe(page, 'graph-canvas')).zoom).toBeGreaterThan(zoom);
  await page.keyboard.press('0');
  await expect(canvas).toHaveAttribute('data-graph-fit-reason', 'keyboard');

  // Escape hands the keyboard to the search field.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('graph-filter')).toBeFocused();

  // Back in, on the same node; Enter does what a click does.
  await canvas.focus();
  await expect(canvas).toHaveAttribute('data-graph-focused', moved);
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/#graph$/);
});

test('#5n2p7phw: the local graph by keyboard: in on the page itself, an arrow moves, Enter opens, Escape goes to List', async ({ page, vault }) => {
  await seed(vault);
  await page.goto('/#/Hub');
  await page.getByTestId('local-graph-toggle').click();
  const local = page.getByTestId('local-graph-canvas');
  await expect(local).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  await page.getByTestId('local-graph').getByTestId('graph-zoom-in').focus();
  await page.keyboard.press('Tab');
  await expect(local).toBeFocused();
  await expect(local).toHaveAttribute('data-graph-focused', 'Hub');
  const moved = await arrowMoves(page, 'local-graph-canvas');
  expect(moved).not.toBe('Hub');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('local-graph-list-toggle')).toBeFocused();
  await local.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(/#\/Hub$/);
});
