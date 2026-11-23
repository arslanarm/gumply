import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #e9bd64bb / #n6cy66ib: blocks with no text inside (an image, a board embed,
 * a database view, a page preview)
 * get the ⋮⋮ gutter like any block: it moves them and deletes them, and the
 * file says so. Nothing else on the page changes.
 */

const PICTURE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#3b82f6"/></svg>',
);

async function saved(request: APIRequestContext, id: string, expected: string) {
  await expect.poll(async () => (await api.getPage(request, id)).content, { timeout: 10_000 }).toBe(expected);
}

async function open(page: Page, id: string) {
  await page.goto(`/#/${encodeURIComponent(id)}`);
  await expect(page.getByTestId('editor-content')).toBeVisible();
}

async function gutterFor(page: Page, block: Locator) {
  await block.hover();
  await expect(page.getByTestId('block-gutter')).toBeVisible();
  return page.getByTestId('block-handle');
}

const cases: Array<{ kind: string; line: string; testId: string; setup: (request: APIRequestContext) => Promise<void> }> = [
  {
    kind: 'an image block',
    line: '![Pic](attachments/picture.svg)',
    testId: 'image-block',
    setup: async () => {
      mkdirSync(path.join(E2E_VAULT, 'attachments'), { recursive: true });
      writeFileSync(path.join(E2E_VAULT, 'attachments', 'picture.svg'), PICTURE);
    },
  },
  {
    kind: 'a board embed',
    line: '![[Plan board.canvas]]',
    testId: 'board-embed',
    setup: async (request) => {
      const response = await request.post('/api/boards', { data: { title: 'Plan board' } });
      expect(response.status()).toBe(201);
    },
  },
  {
    kind: 'a database view',
    line: '![[Tasks view.base]]',
    testId: 'base-embed',
    setup: async (request) => {
      writeFileSync(path.join(E2E_VAULT, 'Tasks view.base'), 'views:\n  - type: table\n    name: Table\n');
      await expect
        .poll(async () => (await api.listPages(request)).some((meta) => meta.id === 'Tasks view.base'), { timeout: 10_000 })
        .toBe(true);
    },
  },
  {
    kind: 'a page preview',
    line: '![[Preview target]]',
    testId: 'page-embed',
    setup: async (request) => {
      const response = await request.post('/api/pages', { data: { title: 'Preview target', content: 'Shown in the preview.' } });
      expect(response.status()).toBe(201);
    },
  },
];

for (const { kind, line, testId, setup } of cases) {
  test(`⋮⋮ moves ${kind}, and deletes it`, async ({ page, request, vault }) => {
    await setup(request);
    const title = `Atom ${testId}`;
    await vault.seed([{ title, content: `First\n\n${line}\n\nLast` }]);
    await open(page, title);
    const block = page.getByTestId(testId);
    await expect(block).toBeVisible();

    // Move: drop it above "First".
    const handle = await gutterFor(page, block);
    await handle.dragTo(page.getByTestId('editor-content').getByText('First', { exact: true }), { targetPosition: { x: 20, y: 2 } });
    await saved(request, title, `${line}\n\nFirst\n\nLast`);

    // Delete it from the block menu.
    await (await gutterFor(page, block)).click();
    await page.getByTestId('block-menu-item-delete').click();
    await saved(request, title, 'First\n\nLast');
    await expect(page.getByTestId(testId)).toHaveCount(0);
  });
}
