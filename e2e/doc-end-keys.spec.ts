import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #k9dwsqxg: Ctrl+End reaches the end of the page and Ctrl+Home its start, also past a block
 * with no text inside (an Obsidian `%% comment %%`, a `$$` math block, an image). A line typed
 * there lands at the end (start) of the file, and only that line is new (D37).
 */

const PICTURE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#3b82f6"/></svg>');

const read = (title: string) => readFileSync(path.join(E2E_VAULT, `${title}.md`), 'utf8');
const body = (raw: string) => (raw.startsWith('---\n') ? raw.slice(raw.indexOf('\n---\n', 4) + 5) : raw);
const lines = (title: string) => body(read(title)).split('\n').filter((line) => line.trim() !== '');

async function open(page: Page, title: string) {
  await page.goto(`/#/${encodeURIComponent(title)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

const saved = (page: Page) => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });

/** Click in a line of text, press the key, then Enter and type a word. */
async function typeAfter(page: Page, clickOn: string, key: string) {
  await page.getByTestId('editor-content').getByText(clickOn, { exact: true }).click();
  await page.keyboard.press(key);
  await page.keyboard.press('Enter');
  await page.keyboard.type('PROBE');
  await saved(page);
}

const endKey = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
const homeKey = process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home';

test.describe('Ctrl+End / Ctrl+Home reach the end and start of the page (#k9dwsqxg)', () => {
  test.beforeEach(() => {
    mkdirSync(path.join(E2E_VAULT, 'attachments'), { recursive: true });
    writeFileSync(path.join(E2E_VAULT, 'attachments', 'a.svg'), PICTURE);
  });

  const endsWith: Array<{ kind: string; last: string[] }> = [
    { kind: 'an Obsidian comment', last: ['%% an Obsidian comment %%'] },
    { kind: 'a math block', last: ['$$', 'x^2', '$$'] },
    { kind: 'an image', last: ['![A](attachments/a.svg)'] },
  ];

  for (const { kind, last } of endsWith) {
    test(`a page ending with ${kind}: Ctrl+End, Enter, type → the last line`, async ({ page, vault }) => {
      const title = `Ends with ${kind}`;
      await vault.seed([{ title, content: `# Daily\n\nText.\n\n${last.join('\n')}\n` }]);
      await open(page, title);
      await typeAfter(page, 'Daily', endKey);
      await expect.poll(() => lines(title)).toEqual(['# Daily', 'Text.', ...last, 'PROBE']);
    });
  }

  test('a task list then a comment: the line goes after the comment, not into the list', async ({ page, vault }) => {
    const title = 'Tasks then comment';
    await vault.seed([{ title, content: '# Daily\n\n- [ ] one\n- [ ] two\n\n%% later %%\n' }]);
    await open(page, title);
    await typeAfter(page, 'Daily', endKey);
    await expect.poll(() => lines(title)).toEqual(['# Daily', '- [ ] one', '- [ ] two', '%% later %%', 'PROBE']);
  });

  test('controls: a page ending in text, and a comment in the middle, are unchanged', async ({ page, vault }) => {
    await vault.seed([
      { title: 'Ends in text', content: '# Daily\n\nText.\n' },
      { title: 'Comment mid', content: '# Daily\n\n%% note %%\n\nText.\n' },
    ]);
    await open(page, 'Ends in text');
    await typeAfter(page, 'Daily', endKey);
    await expect.poll(() => lines('Ends in text')).toEqual(['# Daily', 'Text.', 'PROBE']);
    await open(page, 'Comment mid');
    await typeAfter(page, 'Daily', endKey);
    await expect.poll(() => lines('Comment mid')).toEqual(['# Daily', '%% note %%', 'Text.', 'PROBE']);
  });

  test('from inside a code block or a table cell, Ctrl+End still goes to the end of the page', async ({ page, vault }) => {
    const code = ['```', 'let a = 1', '```'];
    const table = ['| a | b |', '| --- | --- |', '| one | two |'];
    await vault.seed([
      { title: 'From code', content: `# Daily\n\n${code.join('\n')}\n\nText.\n\n%% end %%\n` },
      { title: 'From table', content: `# Daily\n\n${table.join('\n')}\n\n%% end %%\n` },
    ]);
    await open(page, 'From code');
    await typeAfter(page, 'let a = 1', endKey);
    await expect.poll(() => lines('From code')).toEqual(['# Daily', ...code, 'Text.', '%% end %%', 'PROBE']);
    await open(page, 'From table');
    await typeAfter(page, 'one', endKey);
    await expect.poll(() => lines('From table')).toEqual(['# Daily', ...table, '%% end %%', 'PROBE']);
  });

  test('Ctrl+End alone changes nothing on disk', async ({ page, vault }) => {
    const title = 'Just the key';
    await vault.seed([{ title, content: '# Daily\n\nText.\n\n%% an Obsidian comment %%\n' }]);
    await open(page, title);
    const before = read(title);
    await page.getByTestId('editor-content').getByText('Daily', { exact: true }).click();
    await page.keyboard.press(endKey);
    await page.waitForTimeout(2_500);
    expect(read(title)).toBe(before);
  });

  test('a page starting with an image: Ctrl+Home, Enter, type → the first line', async ({ page, vault }) => {
    const title = 'Starts with image';
    await vault.seed([{ title, content: '![A](attachments/a.svg)\n\nText.\n' }]);
    await open(page, title);
    await typeAfter(page, 'Text.', homeKey);
    await expect.poll(() => lines(title)).toEqual(['PROBE', '![A](attachments/a.svg)', 'Text.']);
  });
});
