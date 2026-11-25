import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #mrh4dsr6 (D37): a list item holding only an image (`- ![A](a.png)`, Obsidian's way to put an
 * image in a list) stays in its list. An edit elsewhere on the page used to split the list
 * around the image (and turn an ordered list's following items into bullets) on the next save.
 */

/** The page's text after its frontmatter (a save updates `updated:` there). */
const body = (raw: string) => (raw.startsWith('---\n') ? raw.slice(raw.indexOf('\n---\n', 4) + 5) : raw);

const PICTURE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#3b82f6"/></svg>');

const shapes: Array<{ name: string; list: string }> = [
  { name: 'a bullet', list: '- one\n- ![A](attachments/a.svg)\n- two\n' },
  { name: 'an embed bullet', list: '- ![[a.svg]]\n- two\n' },
  { name: 'an ordered list', list: '1. one\n2. ![A](attachments/a.svg)\n3. three\n' },
  { name: 'the only item', list: '- ![A](attachments/a.svg)\n' },
  { name: 'a task list', list: '- [ ] one\n- [ ] ![A](attachments/a.svg)\n' },
  { name: 'a loose list', list: '- one\n\n- ![A](attachments/a.svg)\n\n- two\n' },
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
      const before = body(readFileSync(file, 'utf8'));
      await page.goto(`/#/${encodeURIComponent(title)}`);
      const editor = page.getByTestId('editor-content');
      await expect(editor).toBeVisible();
      // The image shows inside the list.
      await expect(editor.locator('li').locator('[data-testid="inline-image"], [data-testid="image-block-img"]').first()).toBeVisible();
      await editor.getByText('Top', { exact: true }).click();
      await page.keyboard.press('End');
      await page.keyboard.type('!');
      await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
      await expect.poll(() => body(readFileSync(file, 'utf8'))).toBe(before.replace('Top\n', 'Top!\n'));
    });
  }

  test('typing after the image in its own bullet changes only that line', async ({ page, vault }) => {
    const title = 'List image typed';
    await vault.seed([{ title, content: 'Top\n\n- one\n- ![A](attachments/a.svg)\n- two\n' }]);
    const file = path.join(E2E_VAULT, `${title}.md`);
    const before = body(readFileSync(file, 'utf8'));
    await page.goto(`/#/${encodeURIComponent(title)}`);
    const image = page.getByTestId('editor-content').locator('li').getByTestId('inline-image');
    await expect(image).toBeVisible();
    await image.click();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.type(' x');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await expect
      .poll(() => body(readFileSync(file, 'utf8')))
      .toBe(before.replace('- ![A](attachments/a.svg)\n', '- ![A](attachments/a.svg) x\n'));
  });
});

/**
 * #p6i94g2r: ⋮⋮ an image block between two bullets makes it a bullet holding the image, written as
 * Obsidian writes it; one undo puts it back, and dragged out again it is the image block it was.
 */
test.describe('an image dragged into a list and out again (#p6i94g2r)', () => {
  test.beforeEach(() => {
    mkdirSync(path.join(E2E_VAULT, 'attachments'), { recursive: true });
    writeFileSync(path.join(E2E_VAULT, 'attachments', 'a.svg'), PICTURE);
  });

  test('into the list: a bullet with the image; undo; out again: the image block', async ({ page, vault }) => {
    const title = 'Image into list';
    await vault.seed([{ title, content: '![A](attachments/a.svg)\n\n- one\n- two\n\nEnd\n' }]);
    const file = path.join(E2E_VAULT, `${title}.md`);
    const lines = () => body(readFileSync(file, 'utf8')).split('\n').filter((line) => line.trim() !== '');
    const saved = () => expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    await page.goto(`/#/${encodeURIComponent(title)}`);
    const editor = page.getByTestId('editor-content');

    // ⋮⋮ of the image, dropped on the lower half of "one" (inside its text, where every drop works).
    await page.getByTestId('image-block').hover();
    await expect(page.getByTestId('block-gutter')).toBeVisible();
    const one = editor.getByText('one', { exact: true });
    const box = (await one.boundingBox())!;
    await page.getByTestId('block-handle').dragTo(one, { targetPosition: { x: 20, y: box.height - 2 } });
    await saved();
    await expect.poll(lines).toEqual(['- one', '- ![A](attachments/a.svg)', '- two', 'End']);
    await expect(editor.locator('li').getByTestId('inline-image')).toBeVisible();

    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
    await saved();
    await expect.poll(lines).toEqual(['![A](attachments/a.svg)', '- one', '- two', 'End']);

    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta+Shift' : 'Control+Shift'}+z`);
    await saved();
    await expect.poll(lines).toEqual(['- one', '- ![A](attachments/a.svg)', '- two', 'End']);

    // Its item's ⋮⋮, dropped below "End": the image block again, its Markdown as written.
    await editor.locator('li').getByTestId('inline-image').hover();
    await expect(page.getByTestId('block-gutter')).toBeVisible();
    const end = editor.getByText('End', { exact: true });
    const endBox = (await end.boundingBox())!;
    await page.getByTestId('block-handle').dragTo(end, { targetPosition: { x: 20, y: endBox.height - 2 } });
    await saved();
    await expect.poll(lines).toEqual(['- one', '- two', 'End', '![A](attachments/a.svg)']);
    await expect(page.getByTestId('image-block')).toHaveCount(1);
  });
});
