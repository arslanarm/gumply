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
    // A pasted table is new content: written in normal GFM form (#7witbbun).
    expect((await api.getPage(request, created!.id)).content).toContain(
      '| a | b |\n|---|---|\n| 1 | 2 |',
    );
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

test.describe('pasting HTML tables (#y5iqswjf)', () => {
  async function pasteHtml(page: import('@playwright/test').Page, html: string, text: string) {
    await page.getByTestId('editor-content').evaluate(
      (element, data) => {
        const transfer = new DataTransfer();
        transfer.setData('text/html', data.html);
        transfer.setData('text/plain', data.text);
        element.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
      },
      { html, text },
    );
  }

  test('a web-page table becomes a GFM table block, no stray empty line', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Paste HTML', content: 'Intro' }]);
    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('Intro', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    await pasteHtml(
      page,
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
      'A\tB\n1\t2',
    );
    await expect(body.locator('table td').first()).toHaveText('1');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    expect((await api.getPage(request, created!.id)).content).toBe(
      'Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |',
    );
  });

  test('Sheets/Notion-style: no <th>, formatting, links, pipes and merged cells', async ({
    page,
    vault,
    request,
  }) => {
    const [created] = await vault.seed([{ title: 'Paste rich', content: 'Intro' }]);
    await page.goto('/');
    const body = page.getByTestId('editor-content');
    await body.getByText('Intro', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');

    const html = [
      '<meta charset="utf-8"><google-sheets-html-origin><style>td{border:1px solid}</style>',
      '<table><tbody>',
      '<tr><td><span style="font-weight:bold">Name</span></td><td>Notes</td><td>Link</td></tr>',
      '<tr><td>snake_case</td><td>a | b<br>next</td><td><a href="https://x.y/a_b">site</a></td></tr>',
      '<tr><td colspan="2"><em>merged</em></td><td><code>x|y</code></td></tr>',
      '</tbody></table></google-sheets-html-origin>',
    ].join('');
    await pasteHtml(page, html, 'Name\tNotes\tLink');

    await expect(body.locator('table th').first()).toHaveText('Name');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
      timeout: 10_000,
    });
    expect((await api.getPage(request, created!.id)).content).toBe(
      [
        'Intro',
        '',
        '| **Name** | Notes | Link |',
        '|---|---|---|',
        '| snake_case | a \\| b next | [site](https://x.y/a_b) |',
        '| *merged* |  | `x\\|y` |',
      ].join('\n'),
    );
  });
});

test('a pasted image after a table has no empty paragraph before it (#symxj285)', async ({
  page,
  vault,
  request,
}) => {
  const [created] = await vault.seed([{ title: 'Paste image', content: 'Intro' }]);
  await page.goto('/');
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await body.evaluate((element) => {
    const transfer = new DataTransfer();
    transfer.setData(
      'text/html',
      '<table><tr><th>A</th></tr><tr><td>1</td></tr></table><p><img src="https://example.com/remote.png" alt="remote"></p><p>After</p>',
    );
    transfer.setData('text/plain', 'A\n1');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('image-block')).toHaveCount(1);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
  expect((await api.getPage(request, created!.id)).content).toBe(
    'Intro\n\n| A |\n|---|\n| 1 |\n\n![remote](https://example.com/remote.png)\n\nAfter',
  );
});
