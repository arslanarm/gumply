import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #mp8eadhk: a page whose title differs from its file name (`Ideas: Q3?` is
 * saved as `Ideas Q3.md`, D20) is linked as `[[Ideas Q3|Ideas: Q3?]]`, which
 * Obsidian (by file name) and Gumply both resolve. A rename rewrites it.
 */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

test('[[ menu and typed links use file name + title alias, and renames rewrite them', async ({
  page,
  vault,
  request,
}) => {
  const [target] = await vault.seed([{ title: 'Ideas: Q3?', content: 'Some ideas' }]);
  expect(target!.id).toBe('Ideas Q3');
  const [note] = await vault.seed([{ title: 'Notes', content: 'Intro' }]);

  await page.goto(`/#/${encodeURIComponent(note!.id)}`);
  const body = page.getByTestId('editor-content');
  await body.getByText('Intro', { exact: true }).click();
  await page.keyboard.press('End');

  // 1) Picked from the [[ menu.
  await page.keyboard.type(' see [[Ideas');
  await page.getByTestId(`link-suggestion-${target!.id}`).click();
  // 2) Typed in full.
  await page.keyboard.type(' and [[Ideas: Q3?]] and [[Notes]]');

  const links = body.getByTestId(`wiki-link-${target!.id}`);
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('data-resolved', 'true');
  await expect(links.first()).toContainText('Ideas: Q3?');

  await waitSaved(page);
  expect((await api.getPage(request, note!.id)).content).toBe(
    'Intro see [[Ideas Q3|Ideas: Q3?]] and [[Ideas Q3|Ideas: Q3?]] and [[Notes]]',
  );

  // Renaming to a title that matches its file name goes back to plain links.
  await api.updatePage(request, target!.id, { title: 'Roadmap' });
  await expect
    .poll(async () => (await api.getPage(request, note!.id)).content)
    .toBe('Intro see [[Roadmap]] and [[Roadmap]] and [[Notes]]');

  // …and to file name + alias again when the new title has stripped characters.
  await api.updatePage(request, 'Roadmap', { title: 'Roadmap: v2?' });
  await expect
    .poll(async () => (await api.getPage(request, note!.id)).content)
    .toBe('Intro see [[Roadmap v2|Roadmap: v2?]] and [[Roadmap v2|Roadmap: v2?]] and [[Notes]]');
});

test('a [[link]] split across a line break stays plain text, and an unrelated edit keeps its bytes (#pvrx7t6r)', async ({
  page,
  request,
  vault,
}) => {
  void vault;
  const source = 'See [[Alpha|b\nc]] here.\n\nA real [[Alpha]].\n';
  await writeFile(path.join(E2E_VAULT, 'Alpha.md'), 'Alpha page.\n', 'utf8');
  await writeFile(path.join(E2E_VAULT, 'Notes.md'), source, 'utf8');
  await expect.poll(async () => (await api.listPages(request)).map((item) => item.id).sort(), { timeout: 10_000 }).toEqual(['Alpha', 'Notes']);
  await page.goto('/#/Notes');
  const editor = page.getByTestId('editor-content');
  await expect(editor).toContainText('A real');
  // Only the real link is a link; the split one is text.
  await expect(editor.locator('wiki-link, .wiki-link')).toHaveCount(1);
  await expect(editor).toContainText('[[Alpha|b');
  await editor.getByText('A real').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' More.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  expect(await readFile(path.join(E2E_VAULT, 'Notes.md'), 'utf8')).toBe(source.replace('[[Alpha]].', '[[Alpha]]. More.'));
});
