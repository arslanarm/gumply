import { expect, test } from './fixtures';

/**
 * #cp7xvwjc: the tags that colour a graph get distinct colours (a plain hash
 * put #money and #reading both on orange), and the legend lists the tags that
 * colour nodes, most nodes first, in light and dark.
 */

const TAGS = ['money', 'reading', 'work', 'travel', 'ideas', 'health', 'family', 'books'];

for (const theme of ['light', 'dark'] as const) {
  test(`eight tags, eight distinct legend colours (${theme})`, async ({ page, vault }) => {
    await page.addInitScript((value) => window.localStorage.setItem('gumply:theme', value), theme);
    // `money` colours the most nodes, so it comes first; the rest one page each.
    await vault.seed([
      ...TAGS.map((tag) => ({ title: `Note ${tag}`, content: `About #${tag}.` })),
      { title: 'More money', content: 'Also #money.' },
      { title: 'Even more money', content: 'And #money again.' },
    ]);

    await page.goto('/');
    await page.getByTestId('sidebar-graph').click();
    await expect(page.getByTestId('graph-canvas')).toBeVisible();
    const rows = page.getByTestId('graph-legend-tag');
    await expect(rows).toHaveCount(8);
    await expect(rows.first()).toHaveAttribute('data-tag', 'money');
    const listed = await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-tag')));
    expect([...listed].sort()).toEqual([...TAGS].sort());

    const colours = await rows.evaluateAll((items) =>
      items.map((item) => getComputedStyle(item.querySelector('.graph-legend-dot')!).backgroundColor),
    );
    expect(new Set(colours).size).toBe(8);
    const money = colours[listed.indexOf('money')];
    const reading = colours[listed.indexOf('reading')];
    expect(money).not.toBe(reading);
  });
}
