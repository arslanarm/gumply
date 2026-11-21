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
});
