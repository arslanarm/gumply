import type { Page, Route } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * #evh35bn7: the graph and dialogs load on demand. They must work on the first
 * open (and from a cold deep link), and a failed code download must show a
 * calm message with "Try again", never a blank app.
 *
 * Matches the module in dev (`/src/graph/GraphView.tsx`) and in a production
 * build (`/assets/GraphView-<hash>.js`).
 */
const GRAPH_VIEW_CODE = /\/(src\/graph\/GraphView\.tsx|assets\/GraphView-[\w-]+\.js)(\?|$)/;
const LOCAL_GRAPH_CODE = /\/(src\/graph\/LocalGraphPanel\.tsx|assets\/LocalGraphPanel-[\w-]+\.js)(\?|$)/;
const SHORTCUTS_CODE = /\/(src\/components\/ShortcutsDialog\.tsx|assets\/ShortcutsDialog-[\w-]+\.js)(\?|$)/;

/** Fail downloads of `pattern` until the returned function is called. */
async function blockCode(page: Page, pattern: RegExp): Promise<() => Promise<void>> {
  const handler = (route: Route) => route.abort('internetdisconnected');
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

async function seedLinked(vault: { seed: (pages: { title: string; content: string }[]) => Promise<{ id: string }[]> }) {
  return vault.seed([
    { title: 'Alpha', content: 'Links to [[Beta]]' },
    { title: 'Beta', content: 'Back to [[Alpha]]' },
  ]);
}

test('graph and local graph work on the first open', async ({ page, vault }) => {
  const [alpha] = await seedLinked(vault);
  await page.goto(`/#/${alpha!.id}`);
  await expect(page.getByTestId('editor-content')).toContainText('Links to');

  await page.getByTestId('local-graph-toggle').click();
  await expect(page.locator('[data-testid="local-graph-canvas"] canvas')).toBeVisible();
  await page.getByTestId('right-panel-close').click();

  await page.getByTestId('sidebar-graph').click();
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible();
  await expect(page.getByTestId('graph-subtitle')).toContainText('2 pages');
});

test('a cold deep link to the graph opens it', async ({ page, vault }) => {
  await seedLinked(vault);
  await page.goto('/#graph');
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible();
  await expect(page.getByTestId('graph-subtitle')).toContainText('2 pages');
});

test('graph code failing to download shows a calm error, and Try again recovers', async ({
  page,
  vault,
}) => {
  await seedLinked(vault);
  const unblock = await blockCode(page, GRAPH_VIEW_CODE);
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();

  await page.getByTestId('sidebar-graph').click();
  const error = page.getByTestId('graph-error');
  await expect(error).toContainText('Could not load the graph.');
  await expect(error).toHaveAttribute('data-failure', 'unreachable');
  // The rest of the app is still there.
  await expect(page.getByTestId('sidebar')).toBeVisible();

  await unblock();
  await error.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible();
  await expect(page.getByTestId('graph-error')).toHaveCount(0);
});

test('local graph code failing to download keeps the page usable and can be retried', async ({
  page,
  vault,
}) => {
  const [alpha] = await seedLinked(vault);
  const unblock = await blockCode(page, LOCAL_GRAPH_CODE);
  await page.goto(`/#/${alpha!.id}`);
  const body = page.getByTestId('editor-content');
  await expect(body).toContainText('Links to');

  await page.getByTestId('local-graph-toggle').click();
  const error = page.getByTestId('local-graph-error');
  await expect(error).toContainText('Could not load the local graph.');

  // Typing in the page still works while the panel shows the error.
  await body.getByText('Links to').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more');
  await expect(body).toContainText('and more');

  await unblock();
  await error.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('[data-testid="local-graph-canvas"] canvas')).toBeVisible();

  // Close works from the loaded panel as before.
  await page.getByTestId('right-panel-close').click();
  await expect(page.getByTestId('local-graph')).toHaveCount(0);
});

test('a dialog whose code fails to download shows a small error that Esc closes', async ({
  page,
  vault,
}) => {
  await seedLinked(vault);
  const unblock = await blockCode(page, SHORTCUTS_CODE);
  await page.goto('/');
  await expect(page.getByTestId('editor-content')).toBeVisible();
  await page.getByTestId('sidebar').click({ position: { x: 5, y: 5 } });

  // Both waits below are for a dialog's code to load (or fail to) under
  // load, not for a dropped key: a single `?` each, with a 15 s ceiling
  // (#9a393rp5; #gbq6i6iu showed no key is dropped).
  await page.keyboard.press('?');
  const error = page.getByTestId('dialog-load-error');
  await expect(error).toContainText('Could not open this.', { timeout: 15_000 });
  await page.keyboard.press('Escape');
  await expect(error).toHaveCount(0);

  await unblock();
  await page.keyboard.press('?');
  // The shortcuts part downloads its code now (the earlier fetch was blocked).
  await expect(page.getByTestId('shortcuts-dialog')).toBeVisible({ timeout: 15_000 });
});

test('after a rebuild (graph chunk 404) the graph offers Reload, which brings it back (#fzfrkpta)', async ({
  page,
  vault,
  request,
}) => {
  const [alpha] = await seedLinked(vault);
  // A tab left open across `npm run build`: the old hashed chunk is gone.
  const gone = (route: Route) => route.fulfill({ status: 404, body: 'Not found' });
  await page.route(GRAPH_VIEW_CODE, gone);
  await page.goto(`/#/${alpha!.id}`);
  const body = page.getByTestId('editor-content');
  await body.getByText('Links to').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' typed first');

  await page.getByTestId('sidebar-graph').click();
  const error = page.getByTestId('graph-error');
  await expect(error).toHaveAttribute('data-failure', 'updated');
  await expect(error).toContainText('Gumply was updated.');
  await expect(page.getByTestId('sidebar')).toBeVisible();

  await page.unroute(GRAPH_VIEW_CODE, gone);
  await error.getByRole('button', { name: 'Reload' }).click();
  await expect(page.locator('[data-testid="graph-canvas"] canvas')).toBeVisible();
  // "Your saved pages are safe": what was typed before Reload is on disk.
  expect((await api.getPage(request, alpha!.id)).content).toContain('Links to [[Beta]] typed first');
});
