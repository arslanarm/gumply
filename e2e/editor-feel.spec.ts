import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * #jmg9g5t3: editor rough edges found by the owner.
 * - empty lines (empty paragraphs) must survive save + reload;
 * - the block gutter must stay while the pointer travels to `+` / `⋮⋮`.
 */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

async function blockOutline(page: Page): Promise<string[]> {
  return page
    .getByTestId('editor-content')
    .locator(':scope > *')
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        node.tagName === 'P' ? `p:${node.textContent ?? ''}` : node.tagName.toLowerCase(),
      ),
    );
}

test.describe('empty lines', () => {
  test('empty lines typed between paragraphs are still there after reload', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Spacing', content: 'Alpha' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('Alpha', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Beta');
    await expect.poll(() => blockOutline(page)).toEqual(['p:Alpha', 'p:', 'p:', 'p:Beta']);
    await waitSaved(page);

    // On disk: one extra blank line per empty line, plain Markdown.
    const saved = await api.getPage(request, created!.id);
    expect(saved.content).toBe('Alpha\n\n\n\nBeta');

    await page.reload();
    await expect(page.getByTestId('editor-content').getByText('Beta')).toBeVisible();
    expect(await blockOutline(page)).toEqual(['p:Alpha', 'p:', 'p:', 'p:Beta']);
  });

  test('empty lines between two lists keep the lists apart', async ({ page, vault, request }) => {
    const [created] = await vault.seed([
      { title: 'Lists', content: '- one\n\n\n&nbsp;\n\n- two' },
    ]);

    await page.goto('/');
    await expect(page.getByTestId('editor-content').getByText('two')).toBeVisible();
    expect(await blockOutline(page)).toEqual(['ul', 'p:', 'p:', 'ul']);

    // Editing elsewhere re-serialises the same shape.
    await page.getByTestId('editor-content').getByText('two').click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await waitSaved(page);
    expect((await api.getPage(request, created!.id)).content).toBe('- one\n\n\n&nbsp;\n\n- two!');
  });
});

test.describe('Markdown survives an edit', () => {
  test('links, URLs and to-do lists are written back unchanged', async ({ page, vault, request }) => {
    const content = [
      'Intro',
      '',
      'See [the docs](https://example.com/docs "Docs") and https://example.com/a_b too.',
      '',
      '- [ ] first',
      '- [x] second',
      '',
      '- bullet',
      '',
      '- [ ] task after bullets',
    ].join('\n');
    const [created] = await vault.seed([{ title: 'Round trip', content }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await expect(body.locator('a[href="https://example.com/docs"]')).toHaveText('the docs');

    // Any edit re-serialises the whole page; only the edited line may change.
    await body.getByText('Intro', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await waitSaved(page);

    expect((await api.getPage(request, created!.id)).content).toBe(
      content.replace('Intro', 'Intro!'),
    );
  });
});

test.describe('block gutter reach', () => {
  test('the gutter stays while moving from a heading to its handle', async ({ page, vault }) => {
    await vault.seed([{ title: 'Reach', content: '# A big heading\n\nSome text' }]);

    await page.goto('/');
    const heading = page.getByTestId('editor-content').locator('h1');
    await expect(heading).toBeVisible();

    const box = (await heading.boundingBox())!;
    // Lower part of the heading, i.e. below the gutter's own row.
    const y = box.y + box.height * 0.9;
    await page.mouse.move(box.x + 40, y);
    const gutter = page.getByTestId('block-gutter');
    await expect(gutter).toBeVisible();

    // Walk left into the margin like a person would, checking every step.
    for (let x = box.x + 30; x >= box.x - 40; x -= 5) {
      await page.mouse.move(x, y, { steps: 1 });
      await expect(gutter).toBeVisible();
    }

    // The gutter is centred on the heading's first line.
    const g = (await gutter.boundingBox())!;
    const lineHeight = await heading.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect(Math.abs(g.y + g.height / 2 - (box.y + lineHeight / 2))).toBeLessThan(3);

    await page.getByTestId('block-handle').click();
    await expect(page.getByTestId('block-menu')).toBeVisible();
  });

  test('the gutter follows the row in the left margin and hides over the sidebar', async ({
    page,
    vault,
  }) => {
    await vault.seed([{ title: 'Margin', content: 'Alpha\n\nBeta' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    const beta = body.getByText('Beta', { exact: true });
    await expect(beta).toBeVisible();

    const box = (await beta.boundingBox())!;
    // Straight into the margin left of "Beta", without touching the text first.
    await page.mouse.move(box.x - 30, box.y + box.height / 2);
    await expect(page.getByTestId('block-gutter')).toBeVisible();
    await page.getByTestId('block-insert').click();
    await expect(page.getByTestId('slash-menu')).toBeVisible();
    await page.keyboard.press('Escape');

    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    await page.mouse.move(sidebar.x + sidebar.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('block-gutter')).toHaveCount(0);
  });
});
