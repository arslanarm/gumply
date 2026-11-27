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
  await expect(subtitle).toHaveText('2 pages · 2 links · 1 not created yet');
  const byChip = await subtitle.textContent();

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
