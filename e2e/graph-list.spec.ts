import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #62tnekds (#m5hjtty8's P2-1): the graph's canvas can't be reached by keyboard or read by a screen reader, so the
 * graph also shows as a **list**: the pages it shows right now (the same search and chips), most linked first, each
 * a link that opens it; a page not created yet says so and opening it creates it. While the list is on, the
 * picture's own controls (zoom, Fit, Legend, Forces) step aside. The choice is remembered. Synthetic vault.
 */

async function openGraph(page: Page) {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-subtitle')).toContainText('pages');
}

const seedVault = (vault: { seed: (pages: Array<{ title: string; content?: string }>) => Promise<unknown> }) =>
  vault.seed([
    { title: 'Hub', content: 'Links: [[Alpha]] [[Beta]] [[Gamma]] [[Someday]] #work' },
    { title: 'Alpha', content: 'Back to [[Hub]] and [[Beta]]. #work' },
    { title: 'Beta', content: 'See [[Hub]].' },
    { title: 'Gamma', content: 'Nothing else. #home' },
  ]);

test('#62tnekds: List shows the graph\'s pages as links, most linked first; Enter opens one; the picture\'s controls step aside', async ({ page, vault }) => {
  await seedVault(vault);
  await openGraph(page);
  const toggle = page.getByTestId('graph-list-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  const list = page.getByRole('list', { name: 'Pages in the graph' });
  await expect(list).toBeVisible();
  const links = list.getByRole('link');
  // Hub (4 links) first; the not-created "Someday" says so.
  await expect(links.first()).toHaveText('Hub');
  await expect(list.getByRole('listitem').filter({ hasText: 'Someday' })).toContainText('not created yet');
  await expect(list.getByRole('listitem').filter({ hasText: 'Hub' })).toContainText('#work');

  // The picture's own controls aren't there to act on an invisible canvas.
  await expect(page.getByTestId('graph-canvas')).toHaveCount(0);
  await expect(page.getByTestId('graph-zoom-in')).toHaveCount(0);
  await expect(page.getByTestId('graph-legend')).toHaveCount(0);
  await page.getByTestId('graph-panel-toggle').click();
  await expect(page.getByTestId('graph-forces-toggle')).toHaveCount(0);
  await expect(page.getByTestId('graph-forces-in-list')).toBeVisible();
  await page.getByTestId('graph-panel-toggle').click();

  // The keyboard reaches a page and Enter opens it.
  await list.getByRole('link', { name: 'Alpha' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/Alpha$/);
});

test('#62tnekds: the list follows the search and the chips, and the choice is remembered', async ({ page, vault }) => {
  await seedVault(vault);
  await openGraph(page);
  await page.getByTestId('graph-list-toggle').click();
  const list = page.getByTestId('graph-list');
  await page.getByTestId('graph-filter').fill('tag:#work');
  await expect(list.getByRole('link')).toHaveText(['Hub', 'Alpha']);
  await page.getByTestId('graph-filter').fill('');
  await page.getByRole('button', { name: '#home' }).click();
  await expect(list.getByRole('link')).toHaveText(['Gamma']);

  // Back on the graph later: still a list.
  await page.reload();
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-list-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('graph-list')).toBeVisible();
  // And back to the picture.
  await page.getByTestId('graph-list-toggle').click();
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
});

test('#62tnekds: the local graph has the same List: the page\'s neighbours as links, Enter opens one', async ({ page, vault }) => {
  await seedVault(vault);
  await page.goto('/#/Hub');
  await page.getByTestId('local-graph-toggle').click();
  const toggle = page.getByTestId('local-graph-list-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const list = page.getByRole('list', { name: 'Pages linked with this one' });
  // Hub itself isn't listed; its neighbours are, the not-created one marked.
  await expect(list.getByRole('link', { name: 'Hub' })).toHaveCount(0);
  await expect(list.getByRole('link', { name: 'Alpha' })).toBeVisible();
  await expect(list.getByRole('listitem').filter({ hasText: 'Someday' })).toContainText('not created yet');
  await expect(page.getByTestId('local-graph-canvas')).toHaveCount(0);
  await list.getByRole('link', { name: 'Gamma' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/Gamma$/);
});
