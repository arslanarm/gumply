import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * Text formatting (#bg3cb83t): the selection toolbar (Turn into, Bold,
 * Italic, Strikethrough, Inline code, Link, Highlight), Mod+K for links, the
 * editor's right-click menu in each context, keyboard access, and standard
 * Markdown (plus Obsidian `==`) on disk.
 */

const hashOf = (id: string) => `#/${id.split('/').map(encodeURIComponent).join('/')}`;

async function openPage(page: Page, id: string) {
  await page.goto(`/${hashOf(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function expectSaved(request: APIRequestContext, id: string, content: string) {
  await expect.poll(async () => (await api.getPage(request, id)).content, { timeout: 8_000 }).toBe(content);
}

/** Select a word by double-clicking it (as a user does); only for one-word paragraphs. */
async function selectWord(page: Page, word: string) {
  await page.getByTestId('editor-content').getByText(word, { exact: true }).first().dblclick();
}

/** Select exactly `text` (its first occurrence) in the editor, as a drag would. */
async function selectText(page: Page, text: string) {
  await page.evaluate((needle) => {
    const root = document.querySelector<HTMLElement>('.ProseMirror')!;
    root.focus();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent?.indexOf(needle) ?? -1;
      if (index === -1) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + needle.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`not found: ${needle}`);
  }, text);
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.describe('selection toolbar', () => {
  test('appears over selected text; each button formats it and the file has standard Markdown', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Fmt', content: 'alpha\n\nbravo\n\ncharlie\n\ndelta\n\necho' }]);
    await openPage(page, 'Fmt');
    const toolbar = page.getByTestId('selection-toolbar');
    await expect(toolbar).toHaveCount(0);

    const cases: Array<[string, string, string]> = [
      ['alpha', 'bold', '**alpha**'],
      ['bravo', 'italic', '*bravo*'],
      ['charlie', 'strike', '~~charlie~~'],
      ['delta', 'code', '`delta`'],
      ['echo', 'highlight', '==echo=='],
    ];
    for (const [word, mark] of cases) {
      await selectWord(page, word);
      await expect(toolbar).toBeVisible();
      // Above the selected word.
      const wordBox = (await page.getByTestId('editor-content').getByText(word).first().boundingBox())!;
      const barBox = (await toolbar.boundingBox())!;
      expect(barBox.y + barBox.height).toBeLessThanOrEqual(wordBox.y + 2);
      await page.getByTestId(`format-${mark}`).click();
      await expect(page.getByTestId(`format-${mark}`)).toHaveAttribute('aria-pressed', 'true');
    }
    await expectSaved(request, 'Fmt', cases.map(([, , markdown]) => markdown).join('\n\n'));

    // Pressed again, it removes the format.
    await selectWord(page, 'alpha');
    await page.getByTestId('format-bold').click();
    await expect(page.getByTestId('format-bold')).toHaveAttribute('aria-pressed', 'false');
    await expectSaved(request, 'Fmt', `alpha\n\n${cases.slice(1).map(([, , markdown]) => markdown).join('\n\n')}`);
  });

  test('keyboard: Shift+arrows show it without taking focus; Alt+F10 enters, arrows move, Escape returns', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Keys', content: 'one two three' }]);
    await openPage(page, 'Keys');
    await page.getByTestId('editor-content').getByText('one two three').click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('Shift+ArrowRight');
    const toolbar = page.getByTestId('selection-toolbar');
    await expect(toolbar).toBeVisible();
    // Focus stays in the text: typing replaces the selection.
    await expect(page.locator('.ProseMirror')).toBeFocused();

    await page.keyboard.press('Alt+F10');
    await expect(page.getByTestId('selection-turn-into')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('format-bold')).toBeFocused();
    await page.keyboard.press('Enter');
    await expectSaved(request, 'Keys', '**one** two three');
    await page.keyboard.press('Escape');
    await expect(toolbar).toHaveCount(0);
    await expect(page.locator('.ProseMirror')).toBeFocused();

    // Shortcuts work as the tooltips say.
    await page.keyboard.press('End');
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press(`${mod}+Shift+h`);
    await expectSaved(request, 'Keys', '**one** two ==three==');
    await expect(page.getByTestId('format-bold')).toHaveAttribute('data-tooltip', /Bold · (⌘|Ctrl)\+B/);
  });

  test('not in code blocks; Turn into changes the block', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Turn', content: 'Make me a heading\n\n```\ncode here\n```' }]);
    await openPage(page, 'Turn');
    await page.getByTestId('editor-content').getByText('code here').dblclick();
    await expect(page.getByTestId('selection-toolbar')).toHaveCount(0);

    await selectText(page, 'heading');
    await page.getByTestId('selection-turn-into').click();
    await page.getByTestId('selection-turn-h2').click();
    await expectSaved(request, 'Turn', '## Make me a heading\n\n```\ncode here\n```');
  });

  test('Mod+K with a selection links it (web address or page); without one it opens search', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Links', content: 'Read the docs and the plan' }, { title: 'Roadmap', content: 'r' }]);
    await openPage(page, 'Links');
    await selectText(page, 'docs');
    await page.keyboard.press(`${mod}+k`);
    const input = page.getByTestId('selection-link-input');
    await expect(input).toBeFocused();
    await expect(page.getByTestId('quick-switcher')).toHaveCount(0);
    await input.fill('example.com/docs');
    await input.press('Enter');
    await expectSaved(request, 'Links', 'Read the [docs](https://example.com/docs) and the plan');

    // A page: type its name, pick it; the selected text stays as the alias.
    await selectText(page, 'plan');
    await page.getByTestId('format-link').click();
    await page.getByTestId('selection-link-input').fill('[[Road');
    await expect(page.getByTestId('selection-link-page-Roadmap')).toBeVisible();
    await page.getByTestId('selection-link-input').press('Enter');
    await expectSaved(request, 'Links', 'Read the [docs](https://example.com/docs) and the [[Roadmap|plan]]');

    // No selection: Mod+K is search, as before.
    await page.getByTestId('editor-content').getByText('Read the').click();
    await page.keyboard.press(`${mod}+k`);
    await expect(page.getByTestId('quick-switcher')).toBeVisible();
  });

  test('==highlight== from the file is editable text and survives an unrelated edit byte for byte', async ({ page, request, vault }) => {
    // The last two lines are @opus-hunter's: an intraword `==` pairing with
    // an escaped `\==` further on must keep the escape.
    const body = [
      'Some ==highlighted== text, a == b, **==bold mark==**, `==code==` and \\==literal==.',
      'c==d and \\==literal== here.',
      'c==d, `==code==` and \\==literal== here.',
      // @opus-hunter's other bisect lines (all byte-exact before the fix too).
      'a == b',
      '\\==literal== alone',
      'c==d plus `code`',
      'x==y and ==real==',
      'price==10 and later price==20',
      // Code inside an outer mark keeps it (TipTap's code mark used to drop it).
      '**bold with `code` inside** and ==mark with `code`==.',
      'Other',
    ].join('\n\n');
    await vault.seed([{ title: 'Marks', content: body }]);
    await openPage(page, 'Marks');
    await expect(page.locator('.ProseMirror mark').first()).toHaveText('highlighted');
    await page.getByTestId('editor-content').getByText('Other').click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expectSaved(request, 'Marks', `${body}!`);
  });
});

test.describe('right-click menu', () => {
  test('text: clipboard, formatting with a selection, Turn into, Duplicate and Delete block; Shift keeps the native menu', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Menu', content: 'first line\n\nsecond line' }]);
    await openPage(page, 'Menu');
    const menu = page.getByTestId('editor-context-menu');

    // No selection: no formatting, no Cut/Copy.
    await page.getByTestId('editor-content').getByText('first line').click({ button: 'right' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-context', 'text');
    await expect(page.getByTestId('context-format-bold')).toHaveCount(0);
    await expect(page.getByTestId('context-copy')).toHaveCount(0);
    await expect(page.getByTestId('context-turn-into')).toBeVisible();
    await page.getByTestId('context-duplicate-block').click();
    await expectSaved(request, 'Menu', 'first line\n\nfirst line\n\nsecond line');

    // With a selection: Cut/Copy and formatting act on it (a right-click
    // inside the selection keeps it).
    await selectText(page, 'second');
    const box = (await page.locator('.ProseMirror p', { hasText: 'second line' }).boundingBox())!;
    await page.mouse.click(box.x + 8, box.y + box.height / 2, { button: 'right' });
    await expect(page.getByTestId('context-copy')).toBeVisible();
    await page.getByTestId('context-format-italic').click();
    await expectSaved(request, 'Menu', 'first line\n\nfirst line\n\n*second* line');

    // Turn into (submenu) and Delete block.
    await page.getByTestId('editor-content').getByText('line').nth(1).click({ button: 'right' });
    await page.getByTestId('context-turn-into').click();
    await page.getByTestId('context-turn-h3').click();
    await expectSaved(request, 'Menu', 'first line\n\n### first line\n\n*second* line');
    await page.getByTestId('editor-content').getByText('first line').first().click({ button: 'right' });
    await page.getByTestId('context-delete-block').click();
    await expectSaved(request, 'Menu', '### first line\n\n*second* line');

    // Shift+right-click: the browser's menu, not ours.
    await page.getByTestId('editor-content').getByText('line').first().click({ button: 'right', modifiers: ['Shift'] });
    await expect(menu).toHaveCount(0);
  });

  test.describe('with the clipboard', () => {
    test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

    test('heading: Copy link to heading; Copy and Paste as plain text', async ({ page, request, vault }) => {
      await vault.seed([{ title: 'Doc', content: '## Next steps\n\nbody text' }]);
      await openPage(page, 'Doc');
      await page.getByTestId('editor-content').getByText('Next steps').click({ button: 'right' });
      await page.getByTestId('context-copy-heading-link').click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('[[Doc#Next steps]]');

      await page.evaluate(() => navigator.clipboard.writeText('**not bold**'));
      await page.getByTestId('editor-content').getByText('body text').click();
      await page.keyboard.press('End');
      await page.getByTestId('editor-content').getByText('body text').click({ button: 'right' });
      await page.getByTestId('context-paste-plain').click();
      await expectSaved(request, 'Doc', '## Next steps\n\nbody text\\*\\*not bold\\*\\*');
    });
  });

  test('code blocks and tables show only what applies; links and images have their own items', async ({ page, vault }) => {
    await vault.seed([
      {
        title: 'Ctx',
        content: '```\nlet x = 1\n```\n\n| A | B |\n| --- | --- |\n| cell | two |\n\nSee [site](https://example.com) here.',
      },
    ]);
    await openPage(page, 'Ctx');
    const menu = page.getByTestId('editor-context-menu');
    const items = () => menu.getByRole('menuitem').allTextContents();

    await page.getByTestId('editor-content').getByText('let x = 1').click({ button: 'right' });
    await expect(menu).toHaveAttribute('data-context', 'code');
    expect((await items()).join('|')).not.toMatch(/Turn into|Bold/);
    expect((await items()).join('|')).toMatch(/Delete block/);
    await page.keyboard.press('Escape');

    await page.getByTestId('editor-content').getByText('cell').click({ button: 'right' });
    await expect(menu).toHaveAttribute('data-context', 'table');
    expect((await items()).join('|')).not.toMatch(/Turn into|Duplicate block|Delete block/);
    await page.keyboard.press('Escape');

    await page.getByTestId('editor-content').getByText('site').click({ button: 'right' });
    await expect(menu).toHaveAttribute('data-context', 'link');
    await expect(page.getByTestId('context-open-link')).toBeVisible();
    await expect(page.getByTestId('context-edit-link')).toBeVisible();
    await page.getByTestId('context-remove-link').click();
    await expect(page.locator('.ProseMirror a[href]')).toHaveCount(0);
  });

  test('keyboard: Shift+F10 opens it at the caret with the first item focused; arrows and Escape', async ({ page, vault }) => {
    await vault.seed([{ title: 'KeyMenu', content: 'some text' }]);
    await openPage(page, 'KeyMenu');
    await page.getByTestId('editor-content').getByText('some text').click();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByTestId('editor-context-menu');
    await expect(menu).toBeVisible();
    const first = menu.getByRole('menuitem').first();
    await expect(first).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(first).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.ProseMirror')).toBeFocused();
  });
});
