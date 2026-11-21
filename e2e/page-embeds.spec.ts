import type { Page } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * Page previews (#5dpxwac4): `![[Page]]`, `![[Page#Heading]]`, `![[Page#^id]]`
 * as live, read-only blocks. Insert, live update, Open, block links, missing
 * parts, loops and byte-for-byte files.
 */

const ROADMAP = [
  '# Roadmap',
  '',
  'Intro text.',
  '',
  '## Goals',
  '',
  '- [ ] Ship page previews',
  '- [x] Templates',
  '',
  '## Risks',
  '',
  'Time is short. ^risk',
  '',
].join('\n');

async function openPage(page: Page, title: string) {
  await page.goto(`/#/${encodeURIComponent(title)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function typeAtEnd(page: Page, text: string) {
  await page.getByTestId('editor-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
}

test.describe('page previews (#5dpxwac4)', () => {
  test('/Page preview: pick a page, then a heading from its outline', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Roadmap', content: ROADMAP }, { title: 'Notes', content: 'Weekly notes.' }]);
    await openPage(page, 'Notes');
    await typeAtEnd(page, '/preview');
    await expect(page.getByTestId('slash-menu-item-page-preview')).toBeVisible();
    await page.keyboard.press('Enter');
    // Pages first…
    await page.keyboard.type('Road');
    await page.getByTestId('link-menu').getByText('Roadmap', { exact: true }).click();
    // …then the outline: whole page, headings, blocks.
    const menu = page.getByTestId('link-menu');
    await expect(menu.getByText('Whole page')).toBeVisible();
    await expect(menu.getByText('Goals')).toBeVisible();
    await expect(menu.getByText('Time is short.')).toBeVisible();
    await menu.getByText('Goals').click();

    const embed = page.getByTestId('page-embed');
    await expect(embed).toHaveAttribute('data-part', 'Goals');
    await expect(embed.getByTestId('page-embed-body')).toContainText('Ship page previews');
    await expect(embed.getByTestId('page-embed-body')).not.toContainText('Time is short');
    await expect(embed.locator('input[type="checkbox"]')).toHaveCount(2);
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect((await api.getPage(request, 'Notes')).content.trimEnd()).toBe('Weekly notes.\n\n![[Roadmap#Goals]]');
  });

  test('typing ![[Page#^ offers the blocks of the page; the preview is live', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Roadmap', content: ROADMAP }, { title: 'Notes', content: 'Notes.' }]);
    await openPage(page, 'Notes');
    await typeAtEnd(page, '![[Roadmap#');
    await page.getByTestId('link-menu').getByText('Time is short.').click();
    const embed = page.getByTestId('page-embed');
    await expect(embed).toHaveAttribute('data-part', '^risk');
    await expect(embed.getByTestId('page-embed-body')).toHaveText('Time is short.');

    // An edit to the source (here through the API, as from disk) shows up.
    await api.updatePage(request, 'Roadmap', { content: ROADMAP.replace('Time is short. ^risk', 'Time is very short. ^risk') });
    await expect(embed.getByTestId('page-embed-body')).toHaveText('Time is very short.', { timeout: 8000 });
    expect((await api.getPage(request, 'Notes')).content).toContain('![[Roadmap#^risk]]');
  });

  test('Open jumps to the heading, and to the block', async ({ page, vault }) => {
    const long = `${ROADMAP}\n${Array.from({ length: 40 }, (_, index) => `Filler ${index}.\n`).join('\n')}\n## Later\n\nLast words. ^last\n`;
    await vault.seed([{ title: 'Roadmap', content: long }, { title: 'Notes', content: '![[Roadmap#Later]]\n\n![[Roadmap#^last]]\n' }]);
    await openPage(page, 'Notes');
    const [heading, block] = [page.getByTestId('page-embed').nth(0), page.getByTestId('page-embed').nth(1)];
    await expect(heading.getByTestId('page-embed-body')).toContainText('Last words.');
    await heading.hover();
    await heading.getByTestId('page-embed-open').click();
    await expect(page).toHaveURL(/#\/Roadmap$/);
    await expect(page.getByTestId('editor-content').getByRole('heading', { name: 'Later' })).toBeInViewport();

    await openPage(page, 'Notes');
    await block.hover();
    await block.getByTestId('page-embed-open').click();
    await expect(page).toHaveURL(/#\/Roadmap$/);
    await expect(page.getByTestId('editor-content').getByText('Last words.')).toBeInViewport();
  });

  test('Copy link to block and Copy block embed add one ^id and copy the link', async ({ page, request, vault, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await vault.seed([{ title: 'Roadmap', content: 'First block.\n\nSecond block.\n' }]);
    await openPage(page, 'Roadmap');
    const second = page.getByTestId('editor-content').getByText('Second block.');
    await second.hover();
    await page.getByTestId('block-handle').click();
    await page.getByTestId('block-menu-item-copy-block-link').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    const content = (await api.getPage(request, 'Roadmap')).content;
    const id = /Second block\. \^([a-z0-9]{6})\s*$/.exec(content)?.[1];
    expect(id, content).toBeTruthy();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`[[Roadmap#^${id}]]`);
    // The id is drawn as a faint chip.
    await expect(page.getByTestId('block-id-chip')).toHaveText(`^${id}`);

    // The embed reuses the same id: no second write.
    await second.hover();
    await page.getByTestId('block-handle').click();
    await page.getByTestId('block-menu-item-copy-block-embed').click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`![[Roadmap#^${id}]]`);
    expect((await api.getPage(request, 'Roadmap')).content).toBe(content);

    // The chip is plain text: the caret moves through it and Backspace deletes one character.
    await page.getByTestId('block-id-chip').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await expect(page.getByTestId('editor-content')).toContainText(`Second block. ^${id!.slice(0, 5)}`);
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('block-id-chip')).toHaveText(`^${id}`);

    // The editor's right-click menu offers the same, here for the first block.
    await page.getByTestId('editor-content').getByText('First block.').click({ button: 'right' });
    await page.getByTestId('context-copy-block-embed').click();
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    const firstId = /First block\. \^([a-z0-9]{6})/.exec((await api.getPage(request, 'Roadmap')).content)?.[1];
    expect(firstId).toBeTruthy();
    expect(firstId).not.toBe(id);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`![[Roadmap#^${firstId}]]`);
  });

  test('missing page, heading and block read calmly; Create makes the page', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Roadmap', content: ROADMAP }, { title: 'Notes', content: '![[Nowhere]]\n\n![[Roadmap#Nope]]\n\n![[Roadmap#^gone]]\n' }]);
    await openPage(page, 'Notes');
    const missing = page.getByTestId('page-embed-missing');
    await expect(missing).toHaveCount(3);
    await expect(missing.nth(0)).toHaveAttribute('data-missing', 'page');
    await expect(missing.nth(1)).toHaveAttribute('data-missing', 'heading');
    await expect(missing.nth(2)).toHaveAttribute('data-missing', 'block');
    await page.getByTestId('page-embed-create').click();
    await expect.poll(async () => (await api.listPages(request)).map((item) => item.title)).toContain('Nowhere');
    await expect(page.getByTestId('page-embed-missing')).toHaveCount(2);
  });

  test('no loops: A shows B, B shows A — the second A reads "embedded here already"', async ({ page, vault }) => {
    await vault.seed([
      { title: 'Alpha', content: 'Alpha text.\n\n![[Beta]]\n' },
      { title: 'Beta', content: 'Beta text.\n\n![[Alpha]]\n' },
    ]);
    await openPage(page, 'Alpha');
    const outer = page.getByTestId('page-embed');
    await expect(outer.getByTestId('page-embed-body').first()).toContainText('Beta text.');
    await expect(outer.getByTestId('page-embed-loop')).toContainText('Alpha');
  });

  test('an embed inside running text stays text; files round-trip byte for byte', async ({ page, request, vault }) => {
    const source = 'Intro.\n\nSee ![[Roadmap]] here, and ![[Roadmap#Goals|the goals]].\n\n![[Roadmap#Goals]]\n\n> [!note] Inside\n>\n> ![[Roadmap#^risk]]\n';
    await vault.seed([{ title: 'Roadmap', content: ROADMAP }, { title: 'Notes', content: source }]);
    await openPage(page, 'Notes');
    await expect(page.getByTestId('page-embed')).toHaveCount(2);
    // An unrelated edit: the rest of the file is untouched.
    await page.getByTestId('editor-content').getByText('Intro.').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' More.');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    // (The final newline isn't kept by any page save today: not this feature.)
    expect((await api.getPage(request, 'Notes')).content.trimEnd()).toBe(source.replace('Intro.', 'Intro. More.').trimEnd());
  });

  test('renaming the source keeps every embed working', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Roadmap', content: ROADMAP }, { title: 'Notes', content: '![[Roadmap#Goals]]\n\n![[Roadmap#^risk]]\n' }]);
    await api.updatePage(request, 'Roadmap', { title: 'Plan' });
    expect((await api.getPage(request, 'Notes')).content).toBe('![[Plan#Goals]]\n\n![[Plan#^risk]]\n');
    await openPage(page, 'Notes');
    await expect(page.getByTestId('page-embed-body')).toHaveCount(2);
  });
});
