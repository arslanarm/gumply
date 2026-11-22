import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #iatezw4m: a single newline inside a paragraph (addresses, verse, pasted
 * text) survives load and save byte-for-byte, and shows as a line break, as in
 * Obsidian with "Strict line breaks" off (its default).
 */

const NOTE = [
  'Intro paragraph.',
  '',
  'Line one.',
  'Line two.',
  '',
  '123 Main Street',
  'Springfield, IL 62704',
  'USA',
  '',
  'Roses are red,',
  'Violets are blue,',
  'Sugar is sweet,',
  'And so are you.',
  '',
  '- item one',
  '  continued line',
  '- item two',
  '',
  '> quote line one',
  '> quote line two',
  '',
  '> [!note] Callout',
  '> body one',
  '> body two',
  '',
  'Trailing space ',
  '    indented continuation',
  '',
  'Count',
  '2. item',
  '',
  'Outro paragraph.',
  '',
].join('\n');

const file = () => path.join(E2E_VAULT, 'Soft.md');

async function openNote(page: Page, request: Parameters<typeof api.listPages>[0]) {
  await fs.writeFile(file(), NOTE);
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Soft');
  await page.goto('/#/Soft');
  return page.getByTestId('editor-content');
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

test.describe('soft line breaks (#iatezw4m)', () => {
  test('an edit in another paragraph leaves every soft break byte-for-byte; they show as line breaks', async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    const body = await openNote(page, request);
    // Shown on separate lines, as in Obsidian.
    const verse = body.locator('p', { hasText: 'Roses are red,' });
    await expect(verse.locator('br')).toHaveCount(3);

    await body.getByText('Intro paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Edited.');
    await saved(page);
    expect(await fs.readFile(file(), 'utf8')).toBe(NOTE.replace('Intro paragraph.', 'Intro paragraph. Edited.'));
  });

  test('an edit inside a soft-break paragraph keeps its other line breaks', async ({ page, request, vault }) => {
    void vault;
    const body = await openNote(page, request);
    await body.getByText('Violets are blue,', { exact: false }).click();
    // The caret is somewhere in the verse: go to the end of that line.
    await page.keyboard.press('End');
    await page.keyboard.type(' (blue!)');
    await saved(page);
    const text = await fs.readFile(file(), 'utf8');
    expect(text).toContain('Roses are red,\nViolets are blue, (blue!)\nSugar is sweet,\nAnd so are you.');
    expect(text).toBe(NOTE.replace('Violets are blue,', 'Violets are blue, (blue!)'));
  });

  test('text typed at the start of a line after a soft break is escaped only if it would start a block', async ({ page, request, vault }) => {
    void vault;
    const body = await openNote(page, request);
    // The caret goes to the start of "Line two.": end of the intro, down one
    // paragraph, to the end of its first line, then over the line break.
    await body.getByText('Intro paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type('- ');
    await saved(page);
    const text = await fs.readFile(file(), 'utf8');
    // Without the backslash it would be a list on reload; nothing else changed.
    expect(text).toBe(NOTE.replace('Line one.\nLine two.', 'Line one.\n\\- Line two.'));
    await page.reload();
    await expect(page.getByTestId('editor-content').locator('p', { hasText: 'Line one.' })).toContainText('- Line two.');
  });

  // @opus-hunter's review of ea8bf9f: list continuation lines keep their own
  // indent (Obsidian writes `- item` + `  more` on Shift+Enter), in files with
  // and without tabs; a code span wrapped across lines stays as written.
  const LISTS = [
    'Target paragraph.',
    '',
    '- dash',
    '  two',
    '- nested parent',
    '    - child',
    '      nested continuation',
    '',
    '* star',
    '  two',
    '',
    // Paragraphs between the lists keep them separate lists (a task item and
    // bullets in one Markdown list is a separate, known case).
    'Tasks:',
    '',
    '- [ ] task',
    '  two',
    '',
    'Lazy:',
    '',
    '- lazy',
    'two',
    '',
    'Four:',
    '',
    '- four',
    '    two',
    '',
    '1. step',
    '   more step',
    '',
    'A `code',
    'span` wrapped.',
    '',
  ].join('\n');
  const LISTS_TAB = [
    'Target paragraph.',
    '',
    '- parent',
    '\t- tab nested',
    '\t  two',
    '- dash',
    '  two',
    '',
  ].join('\n');

  // @opus-polish (#h368c8ni): a colour span starting the line after a soft
  // break stays on its own line, as written.
  const COLOUR = 'Target paragraph.\n\nSoft\n<span style="color: var(--color-red);">red</span> after\n';

  for (const [name, text] of [['no tabs', LISTS], ['tabs', LISTS_TAB], ['colour after a soft break', COLOUR]] as const) {
    test(`list continuation lines keep their indent (${name})`, async ({ page, request, vault }) => {
      void vault;
      await fs.writeFile(file(), text);
      await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Soft');
      await page.goto('/#/Soft');
      const body = page.getByTestId('editor-content');
      await body.getByText('Target paragraph.', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' X');
      await saved(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }
});


test.describe('Enter right before a line break (#zvdge7ai)', () => {
  test('splits into two paragraphs and drops the break; the caret starts the second (as in Notion)', async ({ page, request, vault }) => {
    void vault;
    await fs.writeFile(file(), 'Intro line.\nTyped here\n\nOther.\n');
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Soft');
    await page.goto('/#/Soft');
    const body = page.getByTestId('editor-content');
    await body.locator('p', { hasText: 'Intro line.' }).click();
    // The caret goes to the end of the first line (before the break).
    await page.keyboard.press('Home');
    for (let i = 0; i < 'Intro line.'.length; i += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.type('New ');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('Intro line.\n\nNew Typed here\n\nOther.\n');
    await expect(body.locator('p', { hasText: 'New Typed here' }).locator('br')).toHaveCount(0);
  });

  test('in a list item, the item splits the same way', async ({ page, request, vault }) => {
    void vault;
    await fs.writeFile(file(), '- first\n  second\n\nOther.\n');
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Soft');
    await page.goto('/#/Soft');
    const body = page.getByTestId('editor-content');
    await body.locator('li p', { hasText: 'first' }).click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 'first'.length; i += 1) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- first\n- second\n\nOther.\n');
  });
});
