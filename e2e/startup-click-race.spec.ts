import { expect, test } from './fixtures';

/**
 * #s3sszwux side find: the startup effect checked "has the user gone somewhere already?"
 * before its awaits (the health request, a renamed startup page), then navigated to the
 * landing page regardless. A click on Graph that landed during those awaits was overridden:
 * Graph highlighted, the landing page shown, no graph. A slower first `/health` makes the
 * window wide (it showed up with a server busy indexing links in the background).
 */
test('a click on Graph while the startup is still choosing the landing page wins', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Alpha', content: 'See [[Beta]].' },
    { title: 'Beta', content: 'See [[Alpha]].' },
  ]);
  // Hold the health request the startup effect awaits, so the click lands inside that await.
  let held = 0;
  await page.route('**/api/health', async (route) => {
    held += 1;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page).toHaveURL(/#\/graph/);
  // After the held request returns and the startup code finishes, the graph is still what's open.
  await page.waitForTimeout(4_000);
  expect(held).toBeGreaterThan(0);
  await expect(page).toHaveURL(/#\/graph/);
  await expect(page.getByTestId('graph-canvas').or(page.getByTestId('graph-empty'))).toBeVisible();
});

test('with "today\'s note" on startup, a click on Graph while the note is fetched wins too', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Alpha', content: 'See [[Beta]].' },
    { title: 'Beta', content: 'See [[Alpha]].' },
  ]);
  await page.addInitScript(() => window.localStorage.setItem('gumply:startup', 'daily'));
  // Hold the daily-note request the startup awaits (made or fetched), so the click lands inside it.
  let held = 0;
  await page.route('**/api/daily', async (route) => {
    held += 1;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await route.continue();
  });
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page).toHaveURL(/#\/graph/);
  await page.waitForTimeout(4_000);
  expect(held).toBeGreaterThan(0);
  await expect(page).toHaveURL(/#\/graph/);
  await expect(page.getByTestId('graph-canvas').or(page.getByTestId('graph-empty'))).toBeVisible();
});
