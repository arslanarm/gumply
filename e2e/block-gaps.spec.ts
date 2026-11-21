import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #54prcupx (D37): blocks that touch in the file (no blank line between them)
 * still touch after an edit elsewhere. @opus-hunter's 17 shapes from the v0.7
 * gate hunt, plus the same inside a quote and a callout.
 */

const file = () => path.join(E2E_VAULT, 'Gaps.md');

async function open(page: Page, request: Parameters<typeof api.listPages>[0], text: string) {
  await fs.writeFile(file(), text);
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Gaps');
  await page.goto('/#/Gaps');
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function saved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
}

async function editTarget(page: Page) {
  await page.getByTestId('editor-content').getByText('Target paragraph.', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' X');
  await saved(page);
}

const SHAPES: Record<string, string> = {
  'heading → text': '## Heading\nText right under the heading.',
  'heading → list': '## Heading\n- item\n- item two',
  'heading → ordered list': '## Heading\n1. one\n2. two',
  'heading → quote': '## Heading\n> quoted',
  'heading → callout': '## Heading\n> [!note] Title\n> body',
  'heading → code': '## Heading\n```js\nconst a = 1;\n```',
  'heading → table': '## Heading\n| a | b |\n| - | - |\n| 1 | 2 |',
  'heading → rule': '## Heading\n***',
  'heading → heading': '# Title\n## Sub',
  'text → heading': 'Some text\n## Heading',
  'text → quote': 'Some text\n> quoted',
  'text → code': 'Some text\n```\ncode\n```',
  'list → heading': '- a\n- b\n## Heading',
  'list → quote': '- a\n- b\n> quoted',
  'quote → heading': '> quoted\n## Heading',
  'code → heading': '```\ncode\n```\n## Heading',
  'rule → heading': '***\n## Heading',
  'bullets → ordered': '- a\n1. b',
  'ordered → bullets': '1. a\n- b',
  'real note: 10. then bullet': '10. Ten\n- Mixed item',
  'inside a quote': '> ## Heading\n> Text under it\n> - item',
  'inside a callout': '> [!tip] Tips\n> ## Heading\n> Text under it',
  'html block → heading': '<div>html</div>\n\n## After html',
  // @lead's review: setext headings stay setext, with text right under them.
  'setext = → text': 'Title\n===\nText under it.',
  'setext - → text': 'Sub\n---\nText under it.',
  'long setext underline → text': 'Title\n=========\nText under it.',
  // @opus-hunter: a one-character underline is kept too.
  'one-character setext - → text': 'Sub heading\n-\nText under.',
  'one-character setext = → text': 'Main heading\n=\nText under.',
  // D21: extra empty lines between blocks are kept exactly.
  'two blank lines between blocks': '## Heading\n\n\nText after two blank lines.',
  'two blank lines, then touching blocks': 'First\n\n\n## Heading\nText',
  // Not a table in the source (a table can't interrupt a paragraph): raw text.
  'table-like lines right under a paragraph': 'Text\n| a | b |\n| - | - |\n| 1 | 2 |',
};

test.describe('touching blocks stay touching (#54prcupx)', () => {
  for (const [name, shape] of Object.entries(SHAPES)) {
    test(name, async ({ page, request, vault }) => {
      void vault; // resets the vault before and after
      const text = `${shape}\n\nTarget paragraph.\n`;
      await open(page, request, text);
      await editTarget(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  test('# Title right after the frontmatter, with text under it', async ({ page, request, vault }) => {
    void vault;
    const text = '---\nstatus: draft\n---\n# Title\nIntro line.\n\nTarget paragraph.\n';
    await open(page, request, text);
    await editTarget(page);
    expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
  });

  test('a paragraph typed under a heading gets the normal blank line', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, '## Heading\nText under it.\n');
    await page.getByTestId('editor-content').getByText('Text under it.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('New paragraph.');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('## Heading\nText under it.\n\nNew paragraph.\n');
  });

  test('turning the heading into text brings the blank line back, so the file never merges', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, '## Heading\nText under it.\n');
    await page.getByTestId('editor-content').locator('h2').click();
    // Mod+Alt+0 turns the heading into a paragraph.
    await page.keyboard.press('Control+Alt+0');
    await expect(page.getByTestId('editor-content').locator('h2')).toHaveCount(0);
    await saved(page);
    const text = await fs.readFile(file(), 'utf8');
    expect(text).toBe('Heading\n\nText under it.\n');
  });
});

test.describe('empty list items keep their trailing space (#54prcupx)', () => {
  const EMPTY: Record<string, string> = {
    'empty task': '## Tasks\n- [ ] \n',
    'empty done task': '- [x] \n- [ ] real\n',
    'empty bullet': '- \n- b\n',
    'no space stays a bullet': '- [ ]\n- b\n',
  };
  for (const [name, list] of Object.entries(EMPTY)) {
    test(name, async ({ page, request, vault }) => {
      void vault;
      const text = `${list}\nTarget paragraph.\n`;
      await open(page, request, text);
      // An empty task is a task in the editor too (a checkbox), as in Obsidian.
      const boxes = (list.match(/- \[[ x]\] /g) ?? []).length;
      await expect(page.getByTestId('editor-content').getByRole('checkbox')).toHaveCount(boxes);
      await editTarget(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  test('daily note from a template with an empty task: typing under Notes leaves the rest as it was', async ({ page, request, vault }) => {
    void vault;
    const pad = (value: number) => String(value).padStart(2, '0');
    const today = new Date();
    const day = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const template = '## Tasks\n- [ ] \n\n## Notes\n';
    await fs.mkdir(path.join(E2E_VAULT, '.obsidian'), { recursive: true });
    await fs.mkdir(path.join(E2E_VAULT, 'Templates'), { recursive: true });
    await fs.writeFile(path.join(E2E_VAULT, '.obsidian', 'daily-notes.json'), JSON.stringify({ folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Day' }));
    await fs.writeFile(path.join(E2E_VAULT, 'Templates', 'Day.md'), template);
    await fs.writeFile(path.join(E2E_VAULT, 'Inbox.md'), 'Start\n');
    try {
      await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Templates/Day');
      await page.goto('/#/Inbox');
      await page.getByTestId('sidebar-today').click();
      await expect(page).toHaveURL(new RegExp(`#/Daily/${day}$`));
      const note = path.join(E2E_VAULT, 'Daily', `${day}.md`);
      expect(await fs.readFile(note, 'utf8')).toBe(template);
      const body = page.getByTestId('editor-content');
      await expect(body.getByRole('checkbox')).toHaveCount(1);

      await body.locator('h2', { hasText: 'Notes' }).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('Typed line.');
      await saved(page);
      // Only the typed block is new (a new block gets its blank line).
      await expect.poll(() => fs.readFile(note, 'utf8')).toBe(`${template}\nTyped line.\n`);

      await page.reload();
      await expect(page.getByTestId('editor-content').getByRole('checkbox')).toHaveCount(1);
    } finally {
      // Other tests expect the default settings.
      await fs.rm(path.join(E2E_VAULT, '.obsidian'), { recursive: true, force: true });
    }
  });
});
