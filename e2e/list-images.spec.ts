import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #mrh4dsr6 (D37): a list item holding only an image (`- ![A](a.png)`, Obsidian's way to put an
 * image in a list) stays in its list. An edit elsewhere on the page used to split the list
 * around the image (and turn an ordered list's following items into bullets) on the next save.
 */

const PICTURE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#3b82f6"/></svg>');

const shapes: Array<{ name: string; list: string }> = [
  { name: 'a bullet', list: '- one\n- ![A](attachments/a.svg)\n- two\n' },
  { name: 'an embed bullet', list: '- ![[a.svg]]\n- two\n' },
  { name: 'an ordered list', list: '1. one\n2. ![A](attachments/a.svg)\n3. three\n' },
  { name: 'the only item', list: '- ![A](attachments/a.svg)\n' },
  { name: 'a task list', list: '- [ ] one\n- [ ] ![A](attachments/a.svg)\n' },
  { name: 'a loose list', list: '- one\n\n- ![A](attachments/a.svg)\n\n- two\n' },
  { name: 'an image under an item\'s text', list: '- one\n\n  ![A](attachments/a.svg)\n- two\n' },
];

test.describe('an image alone in a list item stays in its list (#mrh4dsr6)', () => {
  test.beforeEach(() => {
    mkdirSync(path.join(E2E_VAULT, 'attachments'), { recursive: true });
    writeFileSync(path.join(E2E_VAULT, 'attachments', 'a.svg'), PICTURE);
  });

  for (const [index, { name, list }] of shapes.entries()) {
    test(`${name}: an edit elsewhere leaves the list byte for byte`, async ({ page, vault }) => {
      const title = `List image ${index}`;
      await vault.seed([{ title, content: `Top\n\n${list}` }]);
      const file = path.join(E2E_VAULT, `${title}.md`);
      const before = readFileSync(file, 'utf8');
      await page.goto(`/#/${encodeURIComponent(title)}`);
      const editor = page.getByTestId('editor-content');
      await expect(editor).toBeVisible();
      // The image shows inside the list.
      await expect(editor.locator('li img').first()).toBeVisible();
      await editor.getByText('Top', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.type('!');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
      await expect.poll(() => readFileSync(file, 'utf8')).toBe(before.replace('Top\n', 'Top!\n'));
    });
  }
});
