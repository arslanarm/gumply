import type { APIRequestContext, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * #hz23dqif (from @kaktuzz): Enter after formatted text starts the new line
 * plain, as Notion does; the formatting stays on the text it was put on.
 * Shift+Enter (a line break in the same block) starts plain too. Typing on in
 * the same line keeps the formatting.
 */

/** Put the caret at the very end of the page body, without clicking a link. */
async function caretAtEnd(page: Page) {
  const body = page.getByTestId('editor-content');
  await body.focus();
  await page.keyboard.press('Control+End');
}

async function open(page: Page, id: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

/** The saved body, once it holds `text`. */
async function savedWith(request: APIRequestContext, id: string, text: string): Promise<string> {
  let content = '';
  await expect
    .poll(async () => (content = (await api.getPage(request, id)).content), { timeout: 8_000 })
    .toContain(text);
  return content;
}

/** The saved line that holds `text` carries no inline markup. */
function expectPlainLine(content: string, text: string) {
  const line = content.split('\n').find((candidate) => candidate.includes(text)) ?? '';
  const rest = line.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*|#{1,6}\s+)?/, '');
  expect(rest, `the line "${line}"`).toBe(text);
}

const BLOCKS: Array<[string, string]> = [
  ['paragraph', '**Bold**'],
  ['heading', '## **Bold**'],
  ['bullet item', '- **Bold**'],
  ['numbered item', '1. **Bold**'],
  ['task item', '- [ ] **Bold**'],
  ['quote', '> **Bold**'],
];

for (const [kind, content] of BLOCKS) {
  test(`Enter after bold text in a ${kind}: the new line is plain`, async ({ page, request, vault }) => {
    const title = `Plain ${kind}`;
    await vault.seed([{ title, content }]);
    await open(page, title);
    // Click the text itself (a task item's checkbox would otherwise take the keys), then End.
    await page.getByTestId('editor-content').getByText('Bold', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('plain words');
    const saved = await savedWith(request, title, 'plain words');
    expectPlainLine(saved, 'plain words');
    expect(saved).toContain('**Bold**');
  });
}

const MARKS: Array<[string, string, string]> = [
  ['italic', '*Slanted*', '*Slanted*'],
  ['strikethrough', '~~Struck~~', '~~Struck~~'],
  ['inline code', '`code`', '`code`'],
  ['highlight', '==Marked==', '==Marked=='],
  ['text colour', '<span style="color: var(--color-red);">Red</span>', '<span style="color: var(--color-red);">Red</span>'],
  ['link', '[Example](https://example.com)', '[Example](https://example.com)'],
];

for (const [kind, content, kept] of MARKS) {
  test(`Enter after ${kind}: the new line is plain, the ${kind} stays where it was`, async ({ page, request, vault }) => {
    const title = `Plain after ${kind}`;
    await vault.seed([{ title, content }]);
    await open(page, title);
    await caretAtEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('plain words');
    const saved = await savedWith(request, title, 'plain words');
    expectPlainLine(saved, 'plain words');
    expect(saved).toContain(kept);
  });
}

test('Shift+Enter after bold text: the next line in the same block is plain too', async ({ page, request, vault }) => {
  await vault.seed([{ title: 'Soft break', content: '**Bold**' }]);
  await open(page, 'Soft break');
  await caretAtEnd(page);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('plain words');
  const saved = await savedWith(request, 'Soft break', 'plain words');
  expect(saved).toContain('**Bold**');
  expect(saved).not.toContain('plain words**');
  expect(saved).not.toMatch(/\*\*plain/);
});

test('typing on in the same line keeps the formatting', async ({ page, request, vault }) => {
  await vault.seed([{ title: 'Same line', content: '**Bold**' }]);
  await open(page, 'Same line');
  await caretAtEnd(page);
  await page.keyboard.type('er');
  await expect.poll(async () => (await api.getPage(request, 'Same line')).content, { timeout: 8_000 }).toBe('**Bolder**');
});
