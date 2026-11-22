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
  // #q7ajxdr4 (@opus-hunter's rc.1 gate): an ordered list right before a
  // bullet list that also holds a task (split into bullet + task lists).
  'ordered → mixed bullets and task (i2)': '1. a\n- c\n- [ ] d',
  'two ordered → mixed bullets and task (i3)': '1. a\n2. b\n- c\n- [ ] d',
  'ordered 1/10 → mixed list with a nested item (i4)': '1. a\n10. b\n- c\n- [ ] d\n\t- e',
  'ordered 1/10 → bullets (i1)': '1. a\n10. b\n- c',
  'ordered → bullet with a nested item (i5)': '1. a\n- c\n\t- nested',
  'ordered → task first, then a bullet': '1. a\n- [ ] d\n- c',
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
  // #6rbi25wy: H4–H6 are headings too, kept byte-exact (they used to save as plain text).
  'h4 alone': '#### Deep heading',
  'h4 → text': '#### Deep heading\nText right under it.',
  'h5 → h6 → text': '##### Five\n###### Six\nTouching text under six.',
  'h1 → h2 → h3 → h4': '# One\n## Two\n### Three\n#### Four',
  'h6 → list': '###### Six\n- item',
  'text → h5': 'Some text\n##### Five',
  'h4 inside a quote': '> #### Quoted four\n> text',
  // ATX closing sequences stay as written, at every level.
  'closed h2': '## Closed two ##',
  'closed h4, uneven': '#### Closed four #######',
  'closed h6 → text': '###### Six ###\nText under six.',
  'closed h3 in a quote': '> ### Quoted ###\n> text',
  'a # that is part of the title': '## Learn C#',
  // All of a heading's bytes, as read (#6rbi25wy): spaces after the hashes, empty headings, indent.
  'extra spaces after the hashes': '####   Extra spaces',
  'a tab after the hash': '#\tTab after',
  'closed with extra spaces': '> ##   Quoted spaces ##\n> text',
  'empty h1': '#',
  'empty h4 with its space': '#### ',
  'empty heading that is only a closing': '### ###',
  'indented heading': '   ## Indented two',
  'a closing that is the whole title': '# Issue #',
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

test.describe('H4–H6 are headings (#6rbi25wy)', () => {
  // @opus-hunter's rc.1 heading fixtures (h46a–h46d, h13c), byte for byte; each ends in `Target paragraph.`.
  const FIXTURES: Record<string, string> = {
    h13c: "# Closed one #\n\n## Closed two ##\n\n### Closed three ###\nText.\n\nTarget paragraph.\n",
    h46a: "#### Deep heading\nText.\n\n##### Five\n###### Six\nTouching text under six.\n\nTarget paragraph.\n",
    h46b: "# One\n## Two\n### Three\n#### Four\n\nTarget paragraph.\n",
    h46c: "#### Closed ####\n\n##### Closed five #####\n\n###### Six ###\nText.\n\nSetext one\n===\n\nSetext two\n---\n\n####   Extra spaces\n\n#### \n\nTarget paragraph.\n",
    h46d: "- item\n#### Heading after list\n> quote\n\n##### Empty below\n\n######NoSpace is text\n\nTarget paragraph.\n",
  };
  for (const [name, text] of Object.entries(FIXTURES)) {
    test(`fixture ${name} comes back byte-exact after a far edit`, async ({ page, request, vault }) => {
      void vault;
      await open(page, request, text);
      await editTarget(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  test('they render as h4, h5, h6 and an edit elsewhere keeps every byte', async ({ page, request, vault }) => {
    void vault;
    const text = '# One\n\n#### Four\n\nBody four.\n\n##### Five\n\n###### Six\n\nTarget paragraph.\n';
    await open(page, request, text);
    const content = page.getByTestId('editor-content');
    await expect(content.locator('h4')).toHaveText('Four');
    await expect(content.locator('h5')).toHaveText('Five');
    await expect(content.locator('h6')).toHaveText('Six');
    await editTarget(page);
    expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
  });

  test('typing #### and a space makes an H4, saved as such', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Target paragraph.\n');
    await page.getByTestId('editor-content').getByText('Target paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('#### New four');
    await expect(page.getByTestId('editor-content').locator('h4')).toHaveText('New four');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('Target paragraph.\n\n#### New four\n');
  });
});

// #628e927t (@opus-hunter, v0.7.0): backslash escapes and math source stay as
// written after an edit elsewhere; new text is still escaped where it must be.
const ESCAPES: Record<string, string> = {
  'esc.md (escapes, snake_case, a quote with \\sum_{i})': "Plain a\\,b and c\\;d and \\$5.\n\nEscapes \\* \\_ \\# \\[ \\] \\\\ \\` stay.\n\nsnake_case_word and a_b_c here.\n\n> snake_case in a quote and \\sum_{i}\n\n- snake_case in a list and x_1_y\n\nPath C:\\Users\\name\\file and \\n literal.\n\nTarget paragraph.\n",
  // #ftx3awn7 (@opus-hunter): tabs inside text, and lazy quote lines.
  'tab.md (tabs inside text)': "Word\tafter a tab and two\t\ttabs.\n\n- item\twith tab\n\nTarget paragraph.\n",
  'lazy.md (lazy quote, callout and list lines)': "> quote line\nlazy continuation\nsecond lazy\n\n> [!note] Callout\n> body\nlazy in callout\n\n- item\nlazy in list\n\nTarget paragraph.\n",
  'nest.md (nested quotes written >>)': "> outer\n>> nested quote\n>> more\n> back\n\n>> starts nested\n\nTarget paragraph.\n",
  'indent.md (indented paragraphs)': "  Indented two at page start.\n\nPlain.\n\n   Indented three mid-file.\n\n## Heading\n  Indented right under a heading.\n\n## Heading two\n\n  Indented under a heading after a blank.\n\nSoft\n  indented continuation line.\n\n- item\n\n  Indented after a list (list continuation).\n\nTarget paragraph.\n",
  // #6wnxxk4y: a backslash ending a paragraph or list item stays single.
  'bs.md (trailing backslashes)': "Ends with a backslash\\\n\nHard break here\\\nnext line.\n\nMid \\ space and a\\b and C:\\dir\\\n\n- item ends\\\n\nTarget paragraph.\n",
  'm1.md (math shapes)': "Inline $x^2 + y_1$ and $$E = mc^2$$ in text, a price $5 and $6.\n\n$$\n\\int_0^1 f(x)\\,dx\n$$\nTouching text after math.\n\n$$ a \\neq b $$\n\n> $$\n> \\sum_{i=1}^n i\n> $$\n\n- item with $\\alpha$\n  $$\n  \\beta\n  $$\n\nEscaped \\$ dollar and `$code$`.\n\nTarget paragraph.\n",
};

test.describe('escapes, math source, tabs and lazy lines are kept (#628e927t, #ftx3awn7)', () => {
  for (const [name, text] of Object.entries(ESCAPES)) {
    test(name, async ({ page, request, vault }) => {
      void vault;
      expect(text).toContain('Target paragraph.');
      await open(page, request, text);
      await editTarget(page);
      expect(await fs.readFile(file(), 'utf8')).toBe(text.replace('Target paragraph.', 'Target paragraph. X'));
    });
  }

  test('a typed line ending in a backslash saves as typed and reads back the same (#6wnxxk4y)', async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Target paragraph.\n');
    await page.getByTestId('editor-content').getByText('Target paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' C:\\dir\\');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('Target paragraph. C:\\dir\\\n');
    await page.reload();
    await expect(page.getByTestId('editor-content')).toContainText('Target paragraph. C:\\dir\\');
  });

  test("a newly typed * or _ that could pair is still escaped; one that can't, isn't", async ({ page, request, vault }) => {
    void vault;
    await open(page, request, 'Target paragraph.\n');
    await page.getByTestId('editor-content').getByText('Target paragraph.', { exact: true }).click();
    await page.keyboard.press('End');
    // Typed text: the * pair would become emphasis on reload without escapes.
    await page.keyboard.type(' 2*3*4 and a_b and x_{i}');
    await saved(page);
    await expect.poll(() => fs.readFile(file(), 'utf8')).toBe('Target paragraph. 2\\*3\\*4 and a_b and x_{i}\n');
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
