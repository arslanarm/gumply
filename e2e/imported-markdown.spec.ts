import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * #82x82ek7 (P0 data loss): editing an imported Obsidian note must not
 * rewrite what the editor doesn't model. Tables, callouts, footnotes, HTML,
 * math and highlights survive byte-for-byte; plain text isn't HTML-escaped.
 */

const OBSIDIAN_NOTE = [
  'Intro paragraph.',
  '',
  '| Name | Score |',
  '|------|-------|',
  '| Ann  | 10    |',
  '| Bob  | 7     |',
  '',
  '> [!note] Callout title',
  '> Callout body text.',
  '',
  'Some ==highlighted== text and ~~strike~~ and a footnote[^1].',
  '',
  '- [x] done item',
  '- [ ] open item',
  '    - nested child',
  '',
  '<details><summary>HTML</summary>inner</details>',
  '',
  'Line one with hard break  ',
  'line two.',
  '',
  'Math $e^{i\\pi}$ inline, a < b, x > y, AT&T, snake_case_name, array[0], 2 * 3, C:\\path, <kbd>Ctrl</kbd>.',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '[^1]: The footnote.',
].join('\n');


/** @opus-hunter's pass-2 fixtures (`/tmp/hunter/fx/*.md`, bodies only: frontmatter is #tterskg4). */
const HUNTER_FIXTURES: Record<string, string> = {
  code: "Intro paragraph.\n\n~~~python\nprint(\"tilde\")\n~~~\n\n````md\n```js\ninner\n```\n````\n\n    indented code block\n    second line\n\nAfter code.",
  tables: "Intro paragraph.\n\n| Left | Center | Right |\n|:--|:-:|--:|\n| a \\| b | `code|x` | [[Welcome|alias]] |\n| [link](https://x.y/a_b) |  | **bold** |\n\nNo | leading | pipes\n--- | --- | ---\n1 | 2 | 3\n\nTail paragraph.",
  escapes: "Intro paragraph.\n\nsnake_case_word and 2*3*4 and C# and `#not-a-tag` here.\n\nURL https://example.com/a_b*c_d and <https://autolink.example>.\n\nPress <kbd>Ctrl</kbd> and use &nbsp; and &copy; as typed.\n\nPrice $5 and $10 stays.",
  obsidian: "Intro paragraph.\n\nInline %%hidden comment%% here.\n\n%%\nblock comment\n%%\n\n![[Welcome]]\n\n![[Welcome#Try it]]\n\nA line with a block id ^abc123\n\nSee [[Welcome#^abc123]].\n\n> [!tip]- Foldable\n> - item one\n> - item two\n>\n> > [!note] Nested\n> > inner\n\n$$\n\\int_0^1 x\\,dx\n$$",
  ws: "Intro paragraph.\n\n* star bullet\n* another\n    * four-space nested\n\n+ plus bullet\n\n1) paren list\n2) second\n\n***\n\n___\n\nSetext Heading\n==============\n\nSub Setext\n----------\n\nHard break with backslash\\\nnext line.",
};

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

test.describe('imported Markdown survives editing', () => {
  test('one edit changes only the edited line of an Obsidian note', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Obsidian note', content: OBSIDIAN_NOTE }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');

    // Rendered, not flattened: a real table, a callout, no live HTML.
    await expect(body.locator('table td').first()).toHaveText('Ann');
    await expect(body.locator('.raw-callout-title')).toHaveText('Callout title');
    await expect(body.locator('mark')).toHaveText('highlighted');
    await expect(body.locator('details')).toHaveCount(0);
    await expect(body.locator('kbd')).toHaveCount(0);

    await body.getByText('Intro paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited.');
    await waitSaved(page);

    expect((await api.getPage(request, created!.id)).content).toBe(
      OBSIDIAN_NOTE.replace('Intro paragraph.', 'Intro paragraph. Edited.'),
    );
  });

  test('typed < > & are saved as typed, not as HTML entities', async ({ page, vault, request }) => {
    const [created] = await vault.seed([{ title: 'Symbols', content: 'Start' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('Start', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('if a > b && x < y then AT&T wins');
    await waitSaved(page);

    expect((await api.getPage(request, created!.id)).content).toBe(
      'Start\n\nif a > b && x < y then AT&T wins',
    );
  });

  test('clicking a table edits its Markdown source', async ({ page, vault, request }) => {
    const table = '| Name | Score |\n|------|-------|\n| Bob  | 7     |';
    const [created] = await vault.seed([{ title: 'Table edit', content: `Intro\n\n${table}` }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.locator('table').click();
    const source = page.getByTestId('raw-block-editor');
    await expect(source).toBeFocused();
    await expect(source).toHaveValue(table);

    await source.fill(table.replace('Bob ', 'Bea '));
    await body.getByText('Intro', { exact: true }).click();
    await expect(body.locator('table td').first()).toHaveText('Bea');
    await waitSaved(page);
    expect((await api.getPage(request, created!.id)).content).toBe(
      `Intro\n\n${table.replace('Bob ', 'Bea ')}`,
    );
  });

  test('a pasted Markdown table becomes a table, not flattened text', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Paste', content: 'Intro' }]);

    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('Intro', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    const table = '| a | b |\n| - | - |\n| 1 | 2 |';
    await body.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, table);

    await expect(body.locator('table td').first()).toHaveText('1');
    await waitSaved(page);
    expect((await api.getPage(request, created!.id)).content).toContain(table);
  });

  for (const [name, content] of Object.entries(HUNTER_FIXTURES)) {
    test(`fixture "${name}": one edit changes only the edited line`, async ({
      page,
      vault,
      request,
    }) => {
      const [created] = await vault.seed([{ title: `Fixture ${name}`, content }]);
      await page.goto('/');
      const body = page.getByTestId('editor-content');
      await body.getByText('Intro paragraph.', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' Edited.');
      await waitSaved(page);
      expect((await api.getPage(request, created!.id)).content).toBe(
        content.replace('Intro paragraph.', 'Intro paragraph. Edited.'),
      );
    });
  }
});
