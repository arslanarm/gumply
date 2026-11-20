import { expect, test, type Page } from '@playwright/test';

/**
 * W2b board card content (#5hme2fwj), through the board lab: Markdown text
 * with [[links]], `[[` autocomplete, live page cards, image/file/link cards
 * (unsafe links inert), and paste.
 */

interface NodeLike {
  id: string;
  type: string;
  text?: string;
  file?: string;
  url?: string;
  gumply?: { kind: string };
}

const board = (page: Page): Promise<{ nodes: NodeLike[] }> =>
  page.evaluate(() => (window as unknown as { __board: { get(): { nodes: NodeLike[] } } }).__board.get());
const opened = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __board: { opened: string[] } }).__board.opened);

/** Open the lab on a board seeded with `nodes` (JSON Canvas). */
async function openSeeded(page: Page, id: string, nodes: object[], theme: 'light' | 'dark' = 'light') {
  await page.addInitScript(
    ([key, value]) => window.localStorage.setItem(key, value),
    [`gumply:board-lab:${id}`, JSON.stringify({ nodes, edges: [] })] as const,
  );
  await page.goto(`/board-lab.html?id=${id}&theme=${theme}`);
  await expect(page.getByTestId('board')).toBeVisible();
}

const sticky = (id: string, text: string, x = 0, y = 0) => ({
  id, type: 'text', text, x, y, width: 260, height: 200, color: '3', gumply: { kind: 'sticky' },
});

test.describe('board card content (W2b)', () => {
  test('sticky text renders Markdown; [[links]] open their page; unresolved links are marked', async ({ page }) => {
    await openSeeded(page, 'w2b-text', [
      sticky('s1', '**Bold** and `code`\n- one\n- two\n\nSee [[Welcome]] and [[Nowhere]]'),
    ]);
    const note = page.getByTestId('board-sticky');
    await expect(note.locator('strong')).toHaveText('Bold');
    await expect(note.locator('code')).toHaveText('code');
    await expect(note.locator('li')).toHaveCount(2);
    const links = note.locator('wiki-link');
    await expect(links.nth(1)).toHaveClass(/is-unresolved/);
    await links.first().click();
    expect(await opened(page)).toEqual(['Welcome.md']);
  });

  test('[[ in a sticky offers pages and boards; boards are written as [[Map.canvas|Map]]', async ({ page }) => {
    await openSeeded(page, 'w2b-auto', [sticky('s1', '', 200, 150)]);
    await page.getByTestId('board-sticky').dblclick();
    const editor = page.getByTestId('board-text-editor');
    await expect(editor).toBeFocused();
    await page.keyboard.type('Plan: [[Q1');
    const menu = page.getByTestId('board-link-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await page.keyboard.type(' map: [[Project');
    await expect(menu.getByRole('option').first()).toContainText('Project map');
    await page.keyboard.press('Tab');
    // Esc with the menu open only closes the menu; the next Esc saves.
    await page.keyboard.type(' [[');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(editor).toBeFocused();
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);

    expect((await board(page)).nodes[0]?.text).toBe(
      'Plan: [[Q1 plan]] map: [[Project map.canvas|Project map]]',
    );
    await expect(page.getByTestId('board-sticky').locator('wiki-link')).toHaveText(['Q1 plan', 'Project map']);
  });

  test('page cards show icon, title and the first lines live; missing pages say so', async ({ page }) => {
    await openSeeded(page, 'w2b-cards', [
      { id: 'p1', type: 'file', file: 'Welcome.md', x: 0, y: 0, width: 360, height: 220 },
      { id: 'p2', type: 'file', file: 'Gone.md', x: 420, y: 0, width: 360, height: 220 },
      { id: 'b1', type: 'file', file: 'Boards/Project map.canvas', x: 0, y: 260, width: 360, height: 140 },
      { id: 'f1', type: 'file', file: 'attachments/brief.pdf', x: 420, y: 260, width: 300, height: 120 },
      { id: 'i1', type: 'file', file: 'attachments/missing.png', x: 0, y: 440, width: 200, height: 150 },
    ]);
    const cards = page.getByTestId('board-page-card');
    await expect(cards.first().getByTestId('board-page-card-title')).toHaveText('Welcome');
    await expect(cards.first()).toContainText('👋');
    await expect(cards.first().getByTestId('board-page-card-preview')).toContainText('Welcome to Gumply');
    await expect(cards.first().getByTestId('board-page-card-preview')).toContainText('Gumply is a quiet place for notes.');
    await expect(cards.first().getByTestId('board-page-card-preview')).not.toContainText('**');
    await expect(cards.nth(1)).toHaveAttribute('data-missing', 'true');
    await expect(page.getByTestId('board-board-card')).toContainText('Project map');
    await expect(page.getByTestId('board-board-card')).toContainText('Whiteboard');
    await expect(page.getByTestId('board-file-card')).toContainText('brief.pdf');
    await expect(page.getByTestId('board-file-card')).toContainText('PDF file');
    await expect(page.getByTestId('board-image-missing')).toContainText('Image not found');

    await cards.first().getByTestId('board-card-open').click();
    expect(await opened(page)).toEqual(['Welcome.md']);
  });

  test('link cards open only http(s)/mailto; javascript: and data: are inert text', async ({ page }) => {
    await openSeeded(page, 'w2b-links', [
      { id: 'l1', type: 'link', url: 'https://example.com/docs', x: 0, y: 0, width: 360, height: 160 },
      { id: 'l2', type: 'link', url: 'javascript:alert(1)', x: 420, y: 0, width: 360, height: 160 },
      { id: 'l3', type: 'link', url: 'data:text/html,<script>alert(2)</script>', x: 0, y: 220, width: 360, height: 160 },
      sticky('s1', '[evil](javascript:alert(3)) and [ok](https://example.com)', 420, 220),
    ]);
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
      dialogs += 1;
      await dialog.dismiss();
    });
    const cards = page.getByTestId('board-link-card');
    await expect(cards.nth(0)).toHaveAttribute('data-safe', 'true');
    await expect(cards.nth(0)).toContainText('example.com');
    await expect(cards.nth(0).getByTestId('board-card-open')).toHaveCount(1);
    for (const index of [1, 2]) {
      await expect(cards.nth(index)).toHaveAttribute('data-safe', 'false');
      await expect(cards.nth(index)).toContainText('Blocked link');
      await expect(cards.nth(index).getByTestId('board-card-open')).toHaveCount(0);
    }
    // Markdown links in text: unsafe ones lose their href.
    const anchors = page.getByTestId('board-sticky').locator('a');
    await expect(anchors).toHaveCount(1);
    await expect(anchors.first()).toHaveAttribute('href', 'https://example.com');
    await page.waitForTimeout(300);
    expect(dialogs).toBe(0);
  });

  test('paste: [[Page]] makes a page card, a URL a link card, lines one text card', async ({ page }) => {
    await page.goto('/board-lab.html?reset=1&theme=light');
    await expect(page.getByTestId('board')).toBeVisible();
    const pasteText = (text: string) =>
      page.evaluate((value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }, text);
    await page.getByTestId('board').click({ position: { x: 400, y: 300 } });

    await pasteText('[[Q1 plan]]');
    await expect(page.getByTestId('board-page-card')).toContainText('Q1 plan');
    await pasteText('https://example.com/a');
    await expect(page.getByTestId('board-link-card')).toContainText('example.com');
    await pasteText('first line\nsecond line\nthird line');
    const nodes = (await board(page)).nodes;
    expect(nodes.map((node) => node.type)).toEqual(['file', 'link', 'text']);
    expect(nodes[0]?.file).toBe('Projects/Q1 plan.md');
    expect(nodes[2]?.text).toBe('first line\nsecond line\nthird line');
  });
});
