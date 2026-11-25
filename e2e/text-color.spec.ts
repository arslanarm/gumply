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

  test('a range across bold is one span per piece; links are never coloured', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Pieces', content: 'one **two** [three](https://example.com) four [[Pieces]] five' }]);
    await openPage(page, 'Pieces');
    await page.getByTestId('editor-content').getByText('one').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
    await page.getByTestId('format-color').click();
    await page.getByTestId('color-text-green').click();
    await expectSaved(
      request,
      'Pieces',
      `${GREEN_TEXT}one </span>**${GREEN_TEXT}two</span>**${GREEN_TEXT} </span>[three](https://example.com)${GREEN_TEXT} four </span>[[Pieces]]${GREEN_TEXT} five</span>`,
    );
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
 * #gcba75f4: in Obsidian only `==…==` colours a link without breaking it (a span around or inside a
 * link turns it into plain text in live preview), so links keep their colour. The palette says so
 * instead of doing nothing: on a link-only selection the colours a link can't take are unavailable,
 * with the reason; on a mixed one, a note says the links keep theirs.
 */
test.describe('colour on links says why (#gcba75f4)', () => {
  /** Select the line under "Top" with the keyboard (clicking a link would follow it). */
  async function selectLineUnderTop(page: Page) {
    await page.getByTestId('editor-content').getByText('Top', { exact: true }).click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  }

  test('a selection that is only a link: text colours and other backgrounds are unavailable, with the reason; yellow works', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Link only', content: 'Top\n\n[label](https://example.com)' }]);
    await openPage(page, 'Link only');
    await selectLineUnderTop(page);
    await page.getByTestId('format-color').click();
    const palette = page.getByTestId('selection-color-palette');
    await expect(palette.getByTestId('color-text-red')).toHaveAttribute('aria-disabled', 'true');
    await expect(palette.getByTestId('color-background-blue')).toHaveAttribute('aria-disabled', 'true');
    await expect(palette.getByTestId('color-background-yellow')).not.toHaveAttribute('aria-disabled', 'true');
    await expect(palette.getByTestId('color-link-note')).toHaveText('Links can only be highlighted in yellow, so they keep working in Obsidian.');
    // An unavailable colour does nothing, and the palette stays open.
    await palette.getByTestId('color-text-red').click();
    await expect(palette).toBeVisible();
    await page.waitForTimeout(800);
    expect(fileBytes('Link only')).not.toContain('<span');
    await palette.getByTestId('color-background-yellow').click();
    await expectSaved(request, 'Link only', 'Top\n\n[==label==](https://example.com)');
  });

  test('a line holding only a wiki link gets the toolbar, and yellow highlights the link', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Target', content: 'x' }, { title: 'Wiki only', content: 'Top\n\n[[Target]]' }]);
    await openPage(page, 'Wiki only');
    await selectLineUnderTop(page);
    await page.getByTestId('format-color').click();
    const palette = page.getByTestId('selection-color-palette');
    await expect(palette.getByTestId('color-text-green')).toHaveAttribute('aria-disabled', 'true');
    await palette.getByTestId('color-background-yellow').click();
    await expectSaved(request, 'Wiki only', 'Top\n\n==[[Target]]==');
    await page.reload();
    await expect(page.getByTestId('editor-content').locator('mark')).toContainText('Target');
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

  test('two wiki links with a space between them count as links only', async ({ page, vault }) => {
    await vault.seed([{ title: 'A', content: 'a' }, { title: 'B', content: 'b' }, { title: 'Two links', content: 'Top\n\n[[A]] [[B]]' }]);
    await openPage(page, 'Two links');
    await selectLineUnderTop(page);
    await page.getByTestId('format-color').click();
    await expect(page.getByTestId('selection-color-palette').getByTestId('color-text-red')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.getByTestId('color-link-note')).toHaveText('Links can only be highlighted in yellow, so they keep working in Obsidian.');
  });

  test('text and a link together: the text is coloured, and a note says the link keeps its colour', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Mixed', content: 'Top\n\nsee [label](https://example.com) here' }]);
    await openPage(page, 'Mixed');
    await selectLineUnderTop(page);
    await page.getByTestId('format-color').click();
    const palette = page.getByTestId('selection-color-palette');
    await expect(palette.getByTestId('color-link-note')).toHaveText('Links in the selection keep their colour: only yellow can highlight a link.');
    await expect(palette.getByTestId('color-text-red')).not.toHaveAttribute('aria-disabled', 'true');
    await palette.getByTestId('color-text-red').click();
    await expectSaved(request, 'Mixed', `Top\n\n${RED_TEXT}see </span>[label](https://example.com)${RED_TEXT} here</span>`);
  });

  test('plain text: no note', async ({ page, vault }) => {
    await vault.seed([{ title: 'Plain', content: 'Top\n\njust words' }]);
    await openPage(page, 'Plain');
    await selectLineUnderTop(page);
    await page.getByTestId('format-color').click();
    await expect(page.getByTestId('selection-color-palette')).toBeVisible();
    await expect(page.getByTestId('color-link-note')).toHaveCount(0);
  });

  test('Russian: the reason is translated', async ({ page, vault }) => {
    await page.addInitScript(() => window.localStorage.setItem('gumply:language', 'ru'));
    await vault.seed([{ title: 'Link ru', content: 'Top\n\n[label](https://example.com)' }]);
    await openPage(page, 'Link ru');
    await selectLineUnderTop(page);
    await page.getByTestId('format-color').click();
    await expect(page.getByTestId('color-link-note')).toHaveText('Ссылку можно выделить только жёлтым: так она продолжит работать в Obsidian.');
  });
});
