import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * Text and background colour (#h368c8ni): the palette in the selection
 * toolbar and the right-click menu, Obsidian-readable spans on disk, theme-
 * aware rendering, and colours from other tools kept byte for byte.
 */

const RED_TEXT = '<span style="color: var(--color-red);">';
const BLUE_BG = '<span style="background-color: rgba(var(--color-blue-rgb), 0.2);">';
const GREEN_TEXT = '<span style="color: var(--color-green);">';

async function openPage(page: Page, id: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function expectSaved(request: APIRequestContext, id: string, content: string) {
  await expect.poll(async () => (await api.getPage(request, id)).content, { timeout: 8_000 }).toBe(content);
}

const fileBytes = (name: string) => readFileSync(path.join(E2E_VAULT, `${name}.md`), 'utf8');

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

/** The computed colour (or background) of the element holding `text`. */
function styleOf(page: Page, text: string, property: 'color' | 'backgroundColor') {
  return page
    .getByTestId('editor-content')
    .getByText(text, { exact: true })
    .first()
    .evaluate((element, prop) => getComputedStyle(element)[prop], property);
}

test.describe('text and background colour', () => {
  test('toolbar: pick a text colour and a background; the file has Obsidian spans; reload shows them', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Colours', content: 'alpha\n\nbravo\n\ncharlie\n\ndelta' }]);
    await openPage(page, 'Colours');

    await selectText(page, 'alpha');
    await page.getByTestId('format-color').click();
    const palette = page.getByTestId('selection-color-palette');
    await expect(palette).toBeVisible();
    // Default plus nine colours in each section.
    await expect(palette.locator('[data-testid^="color-text-"]')).toHaveCount(10);
    await expect(palette.locator('[data-testid^="color-background-"]')).toHaveCount(10);
    await palette.getByTestId('color-text-red').click();
    await expect(palette).toHaveCount(0);
    await expectSaved(request, 'Colours', `${RED_TEXT}alpha</span>\n\nbravo\n\ncharlie\n\ndelta`);

    await selectText(page, 'bravo');
    await page.getByTestId('format-color').click();
    await page.getByTestId('color-background-blue').click();
    await expectSaved(request, 'Colours', `${RED_TEXT}alpha</span>\n\n${BLUE_BG}bravo</span>\n\ncharlie\n\ndelta`);

    // The last used colour is offered first.
    await selectText(page, 'charlie');
    await page.getByTestId('format-color').click();
    await expect(page.getByTestId('color-last-used')).toContainText('Blue background');
    await page.getByTestId('color-last-used').click();
    // Yellow background is Obsidian's own highlight.
    await selectText(page, 'delta');
    await page.getByTestId('format-color').click();
    await page.getByTestId('color-background-yellow').click();
    const expected = `${RED_TEXT}alpha</span>\n\n${BLUE_BG}bravo</span>\n\n${BLUE_BG}charlie</span>\n\n==delta==`;
    await expectSaved(request, 'Colours', expected);
    expect(fileBytes('Colours')).toContain(expected);

    await page.reload();
    await expect(page.getByTestId('editor-content')).toBeVisible();
    // Light theme: Obsidian's light red, and blue at 20%.
    expect(await styleOf(page, 'alpha', 'color')).toBe('rgb(233, 49, 71)');
    expect(await styleOf(page, 'bravo', 'backgroundColor')).toBe('rgba(8, 109, 221, 0.2)');

    // The swatch of the current colour shows selected; Default removes it.
    await selectText(page, 'alpha');
    await page.getByTestId('format-color').click();
    await expect(page.getByTestId('color-text-red')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('color-text-default').click();
    await expectSaved(request, 'Colours', expected.replace(`${RED_TEXT}alpha</span>`, 'alpha'));
  });

  test('a range across bold and links colours every piece, links included (#zvwk8irb)', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Pieces', content: 'one **two** [three](https://example.com) four [[Pieces]] five' }]);
    await openPage(page, 'Pieces');
    await page.getByTestId('editor-content').getByText('one').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
    await page.getByTestId('format-color').click();
    await page.getByTestId('color-text-green').click();
    await expect.poll(async () => (await api.getPage(request, 'Pieces')).content, { timeout: 8_000 }).toContain(`[${GREEN_TEXT}three</span>](https://example.com)`);
    const saved = (await api.getPage(request, 'Pieces')).content;
    // The bold piece, the Markdown link's text and the wiki link are all green; nothing else changed.
    expect(saved).toContain(`**${GREEN_TEXT}two</span>**`);
    expect(saved).toMatch(new RegExp(`${GREEN_TEXT.replace(/[()]/g, '\\$&')}[^<]*\\[\\[Pieces\\]\\][^<]*</span>`));
    expect(saved.replace(/<\/?span[^>]*>/g, '')).toBe('one **two** [three](https://example.com) four [[Pieces]] five');
  });

  test('right-click menu: Colour opens the palette; keyboard: arrows and Enter', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Menu colour', content: 'first line\n\nsecond line' }]);
    await openPage(page, 'Menu colour');
    await selectText(page, 'second');
    await page.getByTestId('editor-content').getByText('second line').click({ button: 'right', position: { x: 5, y: 5 } });
    await page.getByTestId('context-color').click();
    await page.getByTestId('context-color-palette').getByTestId('color-text-green').click();
    await expect(page.getByTestId('editor-context-menu')).toHaveCount(0);
    await expectSaved(request, 'Menu colour', `first line\n\n${GREEN_TEXT}second</span> line`);

    // Keyboard only: Alt+F10 into the toolbar, to Colour, Enter, arrows, Enter.
    await selectText(page, 'first');
    await page.keyboard.press('Alt+F10');
    await expect(page.getByTestId('selection-turn-into')).toBeFocused();
    // Turn into, Bold, Italic, Strikethrough, Code, Highlight, Colour.
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('format-color')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('color-last-used')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('color-text-default')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('color-text-red')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('color-background-red')).toBeFocused();
    await page.keyboard.press('Enter');
    await expectSaved(
      request,
      'Menu colour',
      `<span style="background-color: rgba(var(--color-red-rgb), 0.2);">first</span> line\n\n${GREEN_TEXT}second</span> line`,
    );
    await expect(page.locator('.ProseMirror')).toBeFocused();
  });

  test('colours from other tools render and are written back byte for byte', async ({ page, request, vault }) => {
    const body = [
      'Highlightr <mark style="background: #FF5582A6;">pink mark</mark> and <span style="color:#e03e3e">bare red</span>.',
      '<span style="color: var(--color-purple)">**bold purple** and *italic*</span> then <font color="green">font tag</font>.',
      `==hi ${RED_TEXT}red inside</span> there== and ${BLUE_BG}${RED_TEXT}both</span></span>`,
      '<span class="x">classed</span>, <span style="color: red; font-weight: bold">styled</span>, unpaired <span style="color: red">open',
      'Other',
    ].join('\n\n');
    await vault.seed([{ title: 'Foreign', content: body }]);
    await openPage(page, 'Foreign');
    expect(await styleOf(page, 'pink mark', 'backgroundColor')).toBe('rgba(255, 85, 130, 0.65)');
    expect(await styleOf(page, 'bare red', 'color')).toBe('rgb(224, 62, 62)');
    expect(await styleOf(page, 'font tag', 'color')).toBe('rgb(0, 128, 0)');
    await expect(page.getByTestId('editor-content').locator('strong', { hasText: 'bold purple' })).toBeVisible();

    await page.getByTestId('editor-content').getByText('Other').click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expectSaved(request, 'Foreign', `${body}!`);
    expect(fileBytes('Foreign')).toContain(`${body}!`);
  });

  test('the toolbar and its palette never cover the selected text, near the top or lower down', async ({ page, vault }) => {
    const lines = Array.from({ length: 14 }, (_, index) => `Line ${index} with some words`);
    await vault.seed([{ title: 'Placement', content: lines.join('\n\n') }]);
    await page.setViewportSize({ width: 1100, height: 700 });
    await openPage(page, 'Placement');

    /** Whether the bar's box overlaps any of the selection's line boxes. */
    const covers = () =>
      page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('[data-testid="selection-toolbar"]')!.getBoundingClientRect();
        const rects = [...window.getSelection()!.getRangeAt(0).getClientRects()];
        return rects.some((r) => r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top);
      });

    for (const word of ['Line 0', 'Line 6']) {
      await selectText(page, word);
      expect(await covers(), `${word}, buttons only`).toBe(false);
      await page.getByTestId('format-color').click();
      await expect(page.getByTestId('selection-color-palette')).toBeVisible();
      expect(await covers(), `${word}, palette open`).toBe(false);
      // The button's tooltip is hidden while its palette is open (the pointer still rests on it).
      expect(
        await page.getByTestId('format-color').evaluate((element) => getComputedStyle(element, '::after').display),
      ).toBe('none');
      // Each button toggles its panel (Escape in the text would close the whole bar).
      await page.getByTestId('format-color').click();
      await page.getByTestId('selection-turn-into').click();
      await expect(page.getByTestId('selection-turn-menu')).toBeVisible();
      expect(await covers(), `${word}, Turn into open`).toBe(false);
      await page.getByTestId('selection-turn-into').click();
    }
  });

  test('dark theme: palette colours follow the theme', async ({ page, vault }) => {
    await page.addInitScript(() => window.localStorage.setItem('gumply:theme', 'dark'));
    await vault.seed([{ title: 'Dark', content: `${RED_TEXT}red</span> and ${BLUE_BG}blue</span>` }]);
    await openPage(page, 'Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await styleOf(page, 'red', 'color')).toBe('rgb(251, 70, 76)');
    expect(await styleOf(page, 'blue', 'backgroundColor')).toBe('rgba(2, 122, 255, 0.2)');
  });
});

/**
 * #zvwk8irb (@plony: "every colour should work" on links). Every swatch works on a link: a Markdown
 * link's colour is written inside its text (`[<span>label</span>](url)`), a wiki link's around it
 * (`<span>[[Target]]</span>`), and yellow stays Obsidian's `==…==`. The link stays a link in Gumply
 * after reload (it navigates), and Default gives back the plain link's bytes. In Obsidian both forms
 * work in reading view; its live preview shows them as plain text (the guide's known limits).
 */
test.describe('every colour works on links (#zvwk8irb)', () => {
  /** Select the line under "Top" with the keyboard (clicking a link would follow it). */
  async function selectLineUnderTop(page: Page) {
    await page.getByTestId('editor-content').getByText('Top', { exact: true }).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  }

  async function pick(page: Page, swatch: string) {
    await page.getByTestId('format-color').click();
    const palette = page.getByTestId('selection-color-palette');
    await expect(palette.locator('[aria-disabled="true"]')).toHaveCount(0);
    await expect(palette.getByTestId('color-link-note')).toHaveCount(0);
    await palette.getByTestId(swatch).click();
  }

  test('a Markdown link takes a text colour inside its text, stays a link after reload, and Default gives the bytes back', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Md link', content: 'Top\n\n[label](https://example.com)' }]);
    await openPage(page, 'Md link');
    await selectLineUnderTop(page);
    await pick(page, 'color-text-red');
    await expectSaved(request, 'Md link', `Top\n\n[${RED_TEXT}label</span>](https://example.com)`);
    await page.reload();
    const label = page.getByTestId('editor-content').getByText('label', { exact: true });
    await expect(label).toBeVisible();
    expect(await label.evaluate((element) => element.closest('a')?.getAttribute('href'))).toBe('https://example.com');
    expect(await label.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(233, 49, 71)');
    // The underline takes the colour too, and hover keeps it (@plony: the colour replaces the link's own).
    expect(await label.evaluate((element) => getComputedStyle(element).textDecorationLine)).toContain('underline');
    // The link's own underline (in the line's colour) is hidden; the coloured span draws its own.
    expect(await label.evaluate((element) => getComputedStyle(element.closest('a')!).textDecorationColor)).toBe('rgba(0, 0, 0, 0)');
    await label.hover();
    expect(await label.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(233, 49, 71)');
    await selectLineUnderTop(page);
    await pick(page, 'color-text-default');
    await expectSaved(request, 'Md link', 'Top\n\n[label](https://example.com)');
  });

  test('a wiki link takes a text colour around it, stays a link that navigates after reload, and Default gives the bytes back', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Target', content: 'The target page.' }, { title: 'Wiki colour', content: 'Top\n\n[[Target]]' }]);
    await openPage(page, 'Wiki colour');
    await selectLineUnderTop(page);
    await pick(page, 'color-text-green');
    await expectSaved(request, 'Wiki colour', `Top\n\n${GREEN_TEXT}[[Target]]</span>`);
    await page.reload();
    const link = page.getByTestId('editor-content').locator('.wiki-link-label', { hasText: 'Target' });
    await expect(link).toBeVisible();
    expect(await link.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(8, 185, 78)');
    expect(await link.evaluate((element) => getComputedStyle(element).textDecorationLine)).toContain('underline');
    await link.hover();
    expect(await link.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(8, 185, 78)');
    await selectLineUnderTop(page);
    await pick(page, 'color-text-default');
    await expectSaved(request, 'Wiki colour', 'Top\n\n[[Target]]');
    // Coloured again, it still navigates.
    await selectLineUnderTop(page);
    await pick(page, 'color-text-green');
    await expectSaved(request, 'Wiki colour', `Top\n\n${GREEN_TEXT}[[Target]]</span>`);
    await page.getByTestId('editor-content').locator('.wiki-link-label', { hasText: 'Target' }).click();
    await expect(page).toHaveURL(/#\/Target$/);
  });

  test('a wiki link takes a background colour around it; yellow stays ==…==', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Target', content: 'x' }, { title: 'Wiki bg', content: 'Top\n\n[[Target]]' }]);
    await openPage(page, 'Wiki bg');
    await selectLineUnderTop(page);
    await pick(page, 'color-background-blue');
    await expectSaved(request, 'Wiki bg', `Top\n\n${BLUE_BG}[[Target]]</span>`);
    await selectLineUnderTop(page);
    await pick(page, 'color-background-yellow');
    await expectSaved(request, 'Wiki bg', 'Top\n\n==[[Target]]==');
    await page.reload();
    await expect(page.getByTestId('editor-content').locator('mark')).toContainText('Target');
  });

  test('a text colour and a highlight on one link, each alone and together, for both kinds', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Target', content: 'x' }, { title: 'Both md', content: 'Top\n\n[label](https://example.com)' }, { title: 'Both wiki', content: 'Top\n\n[[Target]]' }]);
    await openPage(page, 'Both md');
    await selectLineUnderTop(page);
    await pick(page, 'color-background-blue');
    await expectSaved(request, 'Both md', `Top\n\n[${BLUE_BG}label</span>](https://example.com)`);
    await selectLineUnderTop(page);
    await pick(page, 'color-text-red');
    await expect.poll(async () => (await api.getPage(request, 'Both md')).content, { timeout: 8_000 }).toMatch(/^Top\n\n\[<span[^>]*><span[^>]*>label<\/span><\/span>\]\(https:\/\/example\.com\)$/);
    const md = (await api.getPage(request, 'Both md')).content;
    expect(md).toContain(RED_TEXT);
    expect(md).toContain(BLUE_BG);
    const label = page.getByTestId('editor-content').getByText('label', { exact: true });
    expect(await label.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(233, 49, 71)');

    await openPage(page, 'Both wiki');
    await selectLineUnderTop(page);
    await pick(page, 'color-background-blue');
    await selectLineUnderTop(page);
    await pick(page, 'color-text-red');
    await expect.poll(async () => (await api.getPage(request, 'Both wiki')).content, { timeout: 8_000 }).toMatch(/^Top\n\n<span[^>]*><span[^>]*>\[\[Target\]\]<\/span><\/span>$/);
    const wiki = (await api.getPage(request, 'Both wiki')).content;
    expect(wiki).toContain(RED_TEXT);
    expect(wiki).toContain(BLUE_BG);
    await page.reload();
    const link = page.getByTestId('editor-content').locator('.wiki-link-label', { hasText: 'Target' });
    expect(await link.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(233, 49, 71)');
  });

  test('text and a link together: both are coloured', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Mixed', content: 'Top\n\nsee [label](https://example.com) here' }]);
    await openPage(page, 'Mixed');
    await selectLineUnderTop(page);
    await pick(page, 'color-text-red');
    await expect.poll(async () => (await api.getPage(request, 'Mixed')).content, { timeout: 8_000 }).toContain(`[${RED_TEXT}label</span>](https://example.com)`);
    const saved = (await api.getPage(request, 'Mixed')).content;
    expect(saved).toContain(`${RED_TEXT}see </span>`);
    expect(saved.replace(/<\/?span[^>]*>/g, '')).toBe('Top\n\nsee [label](https://example.com) here');
  });

  test('on a line holding only a wiki link, no Code or Link button, and Mod+K leaves it alone', async ({ page, vault }) => {
    await vault.seed([{ title: 'Target', content: 'x' }, { title: 'Wiki tools', content: 'Top\n\n[[Target]]' }]);
    await openPage(page, 'Wiki tools');
    await selectLineUnderTop(page);
    await expect(page.getByTestId('format-bold')).toBeVisible();
    await expect(page.getByTestId('format-highlight')).toBeVisible();
    await expect(page.getByTestId('format-code')).toHaveCount(0);
    await expect(page.getByTestId('format-link')).toHaveCount(0);
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`);
    await expect(page.getByTestId('selection-link')).toHaveCount(0);
    await page.waitForTimeout(800);
    expect(fileBytes('Wiki tools')).toContain('Top\n\n[[Target]]');
    expect(fileBytes('Wiki tools')).not.toContain('`');
  });

  test('Mod+E on a lone wiki link leaves it a link (no backticks)', async ({ page, vault }) => {
    await vault.seed([{ title: 'Target', content: 'x' }, { title: 'Wiki code key', content: 'Top\n\n[[Target]]' }]);
    await openPage(page, 'Wiki code key');
    // Select the line without waiting for the toolbar (on main a lone wiki link gets none).
    await page.getByTestId('editor-content').getByText('Top', { exact: true }).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+e`);
    await page.getByTestId('editor-content').getByText('Top', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    expect(fileBytes('Wiki code key')).toContain('Top!\n\n[[Target]]');
    expect(fileBytes('Wiki code key')).not.toContain('`');
  });
});
