import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #fmmght8w: saving never changes bytes in lists the user didn't touch:
 * mixed plain/task lists stay tight or loose as written, ordered numbers and
 * markers are kept, `[X]` stays upper-case.
 */

const file = () => path.join(E2E_VAULT, 'Lists.md');

async function open(page: Page, request: Parameters<typeof api.listPages>[0], text: string) {
  await fs.writeFile(file(), text);
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Lists');
  await page.goto('/#/Lists');
  return page.getByTestId('editor-content');
}

async function editTarget(page: Page) {
  await page.getByTestId('editor-content').getByText('Target paragraph.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

const CASES: Record<string, string> = {
  'tight mixed': 'Target paragraph.\n\n- item\n- [ ] task\n- more\n- [x] done\n',
  'loose mixed': 'Target paragraph.\n\n- [ ] task\n\n- lazy\n\n- four\n',
  'mixed in a quote': 'Target paragraph.\n\n> - item\n> - [ ] task\n',
  'mixed in a callout': 'Target paragraph.\n\n> [!note] Todo\n> - item\n> - [ ] task\n',
  'ordered numbers as written': 'Target paragraph.\n\n1. one\n\n10. ten\n\nText\n\n3) three\n4) four\n',
  'start number': 'Target paragraph.\n\n5. five\n6. six\n',
  'padded numbers': 'Target paragraph.\n\n 9. nine\n10. ten\n\nText\n\n9. nine\n10. ten\n',
  'star and plus bullets': 'Target paragraph.\n\n* star\n* two\n\nText\n\n+ plus\n+ two\n',
  'plus bullets mixed': 'Target paragraph.\n\n+ item\n+ [ ] task\n+ more\n',
  'different bullets are two lists': 'Target paragraph.\n\n- a\n\n* [ ] b\n\n+ c\n\n- [ ] d\n',
  'loose list with tab-nested items': 'Target paragraph.\n\n- a\n\n- parent\n\t- nested\n',
  'loose list with space-nested items': 'Target paragraph.\n\n- a\n\n- parent\n  - nested\n  - [ ] nested task\n\n1. one\n\n2. two\n   1. sub\n',
  'loose nested list after a blank line': 'Target paragraph.\n\n- a\n\n- parent\n\n  - nested\n',
  'list right under text': 'Target paragraph.\n\nText\n- a\n- b\n\nMore\n1. one\n',
  'upper-case X': 'Target paragraph.\n\n- [X] done\n- [ ] open\n',
  'tab nesting': 'Target paragraph.\n\n- parent\n\t- tab nested\n\t- second\n- next\n',
  'lists separated by blank lines': 'Target paragraph.\n\n- a\n- b\n\nText\n\n- parent\n\t- tab nested\n\nMore\n\n- c\n',
};

test.describe('untouched lists keep their bytes (#fmmght8w)', () => {
  for (const [name, text] of Object.entries(CASES)) {
    test(name, async ({ page, request, vault }) => {
      void vault; // resets the vault before and after
      await open(page, request, text);
      await editTarget(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }
});

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

/** Caret at the end of the list item whose text is `text`. */
async function endOf(page: Page, text: string) {
  await page.getByTestId('editor-content').locator('li p', { hasText: new RegExp(`^${text}$`) }).click();
  await page.keyboard.press('End');
}

test.describe('edits inside a list change only what was edited (#fmmght8w)', () => {
  test('ticking a task in a tight mixed list changes only its check', async ({ page, request, vault }) => {
    void vault;
    const body = await open(page, request, '- item\n- [ ] task\n- more\n');
    await body.getByRole('checkbox').check();
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- item\n- [x] task\n- more\n');
  });

  test('ticking an upper-case [X] task back on keeps the X', async ({ page, request, vault }) => {
    void vault;
    const body = await open(page, request, '- [X] done\n- [ ] open\n');
    const box = body.getByRole('checkbox').first();
    await box.uncheck();
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- [ ] done\n- [ ] open\n');
    await box.check();
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- [X] done\n- [ ] open\n');
  });

  test('Enter adds an item without blank lines, plain or to-do', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, '- item\n- [ ] task\n- more\n');
    await endOf(page, 'item');
    await page.keyboard.press('Enter');
    await page.keyboard.type('plain');
    await endOf(page, 'task');
    await page.keyboard.press('Enter');
    await page.keyboard.type('todo');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- item\n- plain\n- [ ] task\n- [ ] todo\n- more\n');
  });

  test('turning a plain item into a to-do mid-list keeps the list tight', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, '- a\n- b\n- c\n');
    await endOf(page, 'a');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/to-do');
    await page.keyboard.press('Enter');
    await page.keyboard.type('new');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- a\n- [ ] new\n- b\n- c\n');
  });

  test('typing inside `10.` keeps the numbers as written', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, '1. one\n\n10. ten\n');
    await endOf(page, 'ten');
    await page.keyboard.type('!');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('1. one\n\n10. ten!\n');
  });
});

/**
 * #fy7pas58: in a loose list (one item holds two blocks with a blank line between them) each item
 * keeps the blank lines it was written with; an item with none stays right under the one before.
 */
test.describe('a loose list keeps each item\'s own blank lines (#fy7pas58)', () => {
  const MIXED: Record<string, string> = {
    'an image under an item\'s text': 'Target paragraph.\n\n- one\n\n  ![A](attachments/a.svg)\n- two\n',
    'a second paragraph under an item\'s text': 'Target paragraph.\n\n- one\n\n  more text\n- two\n',
    'one blank line between two items only': 'Target paragraph.\n\n- a\n- b\n\n- c\n',
    'a numbered list with mixed gaps': 'Target paragraph.\n\n1. one\n\n   more\n2. two\n\n3. three\n',
    'a fully loose list (control)': 'Target paragraph.\n\n- a\n\n- b\n\n- c\n',
  };

  for (const [name, text] of Object.entries(MIXED)) {
    test(name, async ({ page, request, vault }) => {
      void vault;
      await fs.mkdir(path.join(E2E_VAULT, 'attachments'), { recursive: true });
      await fs.writeFile(path.join(E2E_VAULT, 'attachments', 'a.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>');
      await open(page, request, text);
      await editTarget(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  test('a new item added with Enter in a loose list gets a blank line, as before (control)', async ({ page, request, vault }) => {
    void vault;
    const editor = await open(page, request, '- a\n\n- b\n');
    await editor.getByText('b', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('c');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- a\n\n- b\n\n- c\n');
  });

  test('deleting a middle item keeps the other items\' gaps', async ({ page, request, vault }) => {
    void vault;
    const editor = await open(page, request, '- a\n- b\n\n- c\n- d\n');
    await editor.getByText('b', { exact: true }).hover();
    await page.getByTestId('block-handle').click();
    await page.getByTestId('block-menu-item-delete').click();
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- a\n\n- c\n- d\n');
  });

  test('an item moved with ⋮⋮ takes its own gap along', async ({ page, request, vault }) => {
    void vault;
    const editor = await open(page, request, '- a\n- b\n\n- c\n- d\n');
    await editor.getByText('c', { exact: true }).hover();
    const d = editor.getByText('d', { exact: true });
    const box = (await d.boundingBox())!;
    await page.getByTestId('block-handle').dragTo(d, { targetPosition: { x: 5, y: box.height - 2 } });
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('- a\n- b\n- d\n\n- c\n');
  });

  test('pasting a loose list writes it loose, as before', async ({ page, request, vault }) => {
    void vault;
    const editor = await open(page, request, 'Target paragraph.\n');
    await editor.getByText('Target paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', '- x\n\n- y\n');
      document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('Target paragraph.\n\n- x\n\n- y\n');
  });
});
