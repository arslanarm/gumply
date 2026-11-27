import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * #yy347xgi (3), from #m5hjtty8's hunt: a tag chip is its `tag:#x` term in the search. Clicking it writes the term
 * into the field (seen, editable, cleared with it); the chip and the typed term give the same graph; editing the
 * term away un-presses the chip. Synthetic vault.
 */

async function openGraph(page: Page) {
  await page.goto('/');
  await page.getByTestId('sidebar-graph').click();
  await expect(page.getByTestId('graph-subtitle')).toContainText('pages');
}

test('#yy347xgi: a tag chip is its tag: term in the search, and the chip and the typed term give one graph', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Plan', content: 'See [[Notes]] and [[Someday]]. #work' },
    { title: 'Notes', content: 'Back to [[Plan]]. #work' },
    { title: 'Garden', content: 'Nothing here. #home' },
  ]);
  await openGraph(page);
  const field = page.getByTestId('graph-filter');
  const chip = page.getByRole('button', { name: '#work' });
  const subtitle = page.getByTestId('graph-subtitle');

  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(field).toHaveValue('tag:#work');
  // The not-created page Plan links to stays, as the chip always kept it.
  await expect(subtitle).toHaveText(/^2 pages · \d+ links · 1 not created yet$/);
  const byChip = await subtitle.textContent();

  // A second chip joins a group, either tag (OR); un-pressing one keeps the query valid.
  const home = page.getByRole('button', { name: '#home' });
  await home.click();
  await expect(field).toHaveValue('(tag:#work OR tag:#home)');
  await expect(subtitle).toHaveText(/^3 pages /);
  await home.click();
  await expect(field).toHaveValue('tag:#work');

  // Typed by hand: the same graph, and the chip shows pressed.
  await field.fill('');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await field.fill('tag:#work');
  await expect(subtitle).toHaveText(byChip!);
  await expect(chip).toHaveAttribute('aria-pressed', 'true');

  // Editing the term away un-presses the chip; Clear clears both.
  await field.fill('plan');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.click();
  await expect(field).toHaveValue('plan tag:#work');
  await page.getByTestId('graph-filter-clear').click();
  await expect(field).toHaveValue('');
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
});

type Probe = { nodes: () => Array<{ id: string }>; spotlight: () => string[] | null };
const probe = (page: Page) =>
  page.evaluate(() => {
    const graph = (window as unknown as { __gumplyGraphs: Record<string, Probe> }).__gumplyGraphs['graph-canvas']!;
    return { nodes: graph.nodes().map((node) => node.id).sort(), spotlight: graph.spotlight() };
  });

test('#yy347xgi (4): a search isolates by default; "Show the rest" keeps the rest dimmed, Enter fits to the matches, and it is remembered', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Plan', content: 'See [[Notes]] and [[Someday]]. #work' },
    { title: 'Notes', content: 'Back to [[Plan]]. #work' },
    { title: 'Garden', content: 'Nothing here. #home' },
  ]);
  await openGraph(page);
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  // No search: no toggle.
  await expect(page.getByTestId('graph-show-rest')).toHaveCount(0);

  // Default, unchanged: the search isolates its matches.
  await page.getByTestId('graph-filter').fill('plan');
  await expect.poll(async () => (await probe(page)).nodes).toEqual(['Plan']);
  await expect.poll(async () => (await probe(page)).spotlight).toBeNull();

  // Show the rest: every node is drawn again, the match is the spotlight (the rest dimmed).
  const toggle = page.getByTestId('graph-show-rest');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  // Enter at once, while the re-drawn graph is still settling: the view fits to the matches, and stays so.
  await page.getByTestId('graph-filter').press('Enter');
  await expect(canvas).toHaveAttribute('data-graph-fit-reason', 'matches');
  await expect.poll(async () => (await probe(page)).nodes.length).toBe(4);
  await expect.poll(async () => (await probe(page)).spotlight).toEqual(['Plan']);
  // The subtitle still describes the matches.
  await expect(page.getByTestId('graph-subtitle')).toContainText('1 page');
  // Once it has settled, no automatic fit has put everything back over the user's fit.
  await expect(canvas).toHaveAttribute('data-graph-engine', 'stopped', { timeout: 15_000 });
  await page.waitForTimeout(1000);
  await expect(canvas).toHaveAttribute('data-graph-fit-reason', 'matches');

  // Remembered: after a reload, the same search shows in context again.
  await page.reload();
  await page.getByTestId('graph-filter').fill('plan');
  await expect(page.getByTestId('graph-show-rest')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await probe(page)).spotlight).toEqual(['Plan']);
});

test('#yy347xgi (4): a fit pinned to matches that a filter then removes is forgotten, and the view fits as usual', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Plan', content: 'See [[Notes]] and [[Someday]]. #work' },
    { title: 'Notes', content: 'Back to [[Plan]]. #work' },
  ]);
  await openGraph(page);
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-graph-ready', 'true', { timeout: 15_000 });
  // Pin the fit to the not-created page's match.
  await page.getByTestId('graph-filter').fill('someday');
  const toggle = page.getByTestId('graph-show-rest');
  if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
  await page.getByTestId('graph-filter').press('Enter');
  await expect(canvas).toHaveAttribute('data-graph-fit-reason', 'matches');
  // "Existing files only" removes that page: the pin goes, and the next fit is the ordinary one.
  await page.getByTestId('graph-panel-toggle').click();
  await page.getByTestId('graph-filter-hideUnresolved').click();
  await expect(canvas).not.toHaveAttribute('data-graph-fit-reason', 'matches', { timeout: 10_000 });
});
