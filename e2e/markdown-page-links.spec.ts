import { test, expect } from './fixtures';
import { expectPageTitle } from './support/ui';

/**
 * #idmfvvkg (Obsidian parity): a Markdown link to a page, `[x](Note.md)`, is a
 * link like `[[Note]]`: the target's “Linked from” panel lists the source, and
 * the target's local graph has the source as a neighbour. Every name is invented.
 */
test.describe('Markdown links to pages', () => {
  test('show in “Linked from” and in the local graph', async ({ page, vault }) => {
    const [target] = await vault.seed([{ title: 'Seed catalogue', content: 'Tomatoes and beans.' }]);
    const [source] = await vault.seed([{ title: 'Spring tasks', content: 'Order from [the catalogue](Seed%20catalogue.md) this week.' }]);
    await vault.seed([{ title: 'Unrelated', content: 'Nothing linked.' }]);

    await page.goto(`/#/${encodeURIComponent(target!.id)}`);
    await expectPageTitle(page, 'Seed catalogue');
    await expect(page.getByTestId('backlinks-panel')).toContainText('Linked from');
    await expect(page.getByTestId(`backlink-${source!.id}`)).toContainText('Spring tasks');

    await page.getByTestId('local-graph-toggle').click();
    await expect(page.getByTestId('local-graph-canvas')).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __gumplyGraphs: Record<string, { nodes: () => Array<{ id: string }> }> }).__gumplyGraphs['local-graph-canvas']
            ?.nodes()
            .map((node) => node.id)
            .sort() ?? [],
        ),
      )
      .toEqual([source!.id, target!.id].sort());
  });
});
