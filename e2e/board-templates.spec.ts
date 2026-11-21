import type { APIRequestContext } from '@playwright/test';
import { api, expect, test } from './fixtures';

/**
 * Board templates (spec/v0-6 §D, #yewapn9k): New whiteboard opens a gallery
 * (Blank + five templates), also reachable from Cmd+K and `/template`. A
 * board made from a template is a normal `.canvas` file.
 */

interface BoardFile {
  nodes: Array<{ id: string; type: string; text?: string; label?: string; gumply?: { kind: string; shape?: string } }>;
  edges: Array<{ fromNode: string; toNode: string; label?: string }>;
}

async function boardOnDisk(request: APIRequestContext, id: string): Promise<BoardFile> {
  const response = await request.get(`/api/boards/${encodeURIComponent(id)}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { board: BoardFile }).board;
}

test.describe('board templates (#yewapn9k)', () => {
  test('New whiteboard → Kanban: a board with the three columns, named after the template', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    await page.goto('/');
    await page.getByTestId('new-board-button').click();

    const gallery = page.getByTestId('template-gallery');
    await expect(gallery).toBeVisible();
    // Blank plus the five templates, each with a preview.
    for (const id of ['blank', 'kanban', 'mind-map', 'retrospective', 'flowchart', 'weekly-plan']) {
      await expect(page.getByTestId(`template-${id}`)).toBeVisible();
    }
    await expect(gallery.locator('.template-preview')).toHaveCount(5);

    // Keyboard: Blank is picked first; → moves to Kanban, Enter creates it.
    await expect(page.getByTestId('template-blank')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('template-kanban')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(gallery).toBeHidden();
    await expect(page).toHaveURL(/#\/Kanban\.canvas$/);
    await expect(page.getByTestId('board-page')).toBeVisible();
    await expect(page.getByTestId('board-frame')).toHaveCount(3);
    await expect(page.getByTestId('page-title-input')).toHaveValue('Kanban');

    const board = await boardOnDisk(request, 'Kanban.canvas');
    expect(board.nodes.filter((node) => node.type === 'group').map((node) => node.label)).toEqual(['To do', 'Doing', 'Done']);
    expect(board.nodes.some((node) => node.gumply?.kind === 'sticky')).toBe(true);
  });

  test('Escape closes the gallery without creating anything', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    await page.goto('/');
    const before = (await api.listPages(request)).length;
    await page.getByTestId('new-board-button').click();
    await expect(page.getByTestId('template-gallery')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('template-gallery')).toBeHidden();
    expect((await api.listPages(request)).length).toBe(before);
  });

  test('Cmd+K "template" → New board from template… → Flowchart', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Notes', content: 'Hello' }]);
    await page.goto('/');
    await expect(page.getByTestId('editor-content')).toBeVisible();
    await page.keyboard.press('Control+k');
    await page.getByTestId('quick-switcher-input').fill('template');
    await expect(page.getByTestId('search-from-template')).toHaveText('New board from template…');
    await page.getByTestId('search-from-template').click();
    await page.getByTestId('template-flowchart').click();

    await expect(page).toHaveURL(/#\/Flowchart\.canvas$/);
    await expect(page.getByTestId('board-page')).toBeVisible();
    const board = await boardOnDisk(request, 'Flowchart.canvas');
    expect(board.nodes.map((node) => node.gumply?.shape)).toContain('diamond');
    expect(board.edges.map((edge) => edge.label).filter(Boolean).sort()).toEqual(['No', 'Yes']);
    await expect(page.locator('.react-flow__edge')).toHaveCount(5);
  });

  test('/template in a page: pick Retrospective; the board is made inside the page and linked', async ({ page, request, vault }) => {
    await vault.seed([{ title: 'Sprint 12', content: 'Notes' }]);
    await page.goto('/#/Sprint%2012');
    const editor = page.getByTestId('editor-content');
    await editor.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/template');
    await expect(page.getByTestId('slash-menu-item-board-template')).toBeVisible();
    await page.keyboard.press('Enter');
    await page.getByTestId('template-retrospective').click();

    const link = page.getByTestId('wiki-link-Sprint 12/Retrospective.canvas');
    await expect(link).toHaveText('Retrospective');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
    expect((await api.getPage(request, 'Sprint 12')).content).toContain('[[Retrospective.canvas|Retrospective]]');
    const board = await boardOnDisk(request, 'Sprint 12/Retrospective.canvas');
    expect(board.nodes.filter((node) => node.type === 'group').map((node) => node.label)).toEqual([
      'Went well',
      'To improve',
      'Action items',
    ]);

    // Cancelling the gallery from `/template` inserts nothing.
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/template');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('template-gallery')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('template-gallery')).toBeHidden();
    expect((await api.listPages(request)).filter((item) => item.parentId === 'Sprint 12')).toHaveLength(1);
  });
});
