import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #rpugpydh: a frontmatter value that is exactly one quoted `[[link]]` is a
 * link, as Obsidian 1.14.4 reads it: "Linked from" lists the note with a
 * `key: link` snippet, and the local graph has the edge. An unquoted
 * `up: [[X]]` is not a link. Nothing is written to either file.
 */

const ALPHA = '# Alpha\n\nThe target.\n';
const PROP = '---\nrelated: "[[Alpha|the a]]"\nup: [[Lonely]]\n---\n\nNo links in the body.\n';
const LONELY = 'Nobody links here.\n';

test('a quoted frontmatter link is a backlink with its key, and a local graph edge; unquoted is not', async ({ page, request, vault }) => {
  void vault;
  await fs.writeFile(path.join(E2E_VAULT, 'Alpha.md'), ALPHA, 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'Prop.md'), PROP, 'utf8');
  await fs.writeFile(path.join(E2E_VAULT, 'Lonely.md'), LONELY, 'utf8');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toEqual(expect.arrayContaining(['Alpha', 'Prop', 'Lonely']));

  await page.goto('/#/Alpha');
  await expect(page.getByTestId('editor-content')).toContainText('The target.');
  const backlink = page.getByTestId('backlink-Prop');
  await expect(backlink).toBeVisible();
  const snippet = backlink.locator('.backlink-snippet');
  await expect(snippet).toHaveText('related: the a');
  await expect(snippet.locator('mark')).toHaveText('the a');

  // The local graph has Prop as Alpha's neighbour.
  await page.getByTestId('local-graph-toggle').click();
  await expect(page.getByTestId('local-graph-canvas')).toBeVisible();
  await expect(page.getByTestId('local-graph-empty')).toHaveCount(0);

  // `up: [[Lonely]]` (unquoted) isn't a link: Lonely has no backlinks.
  await page.goto('/#/Lonely');
  await expect(page.getByTestId('editor-content')).toContainText('Nobody links here.');
  await expect(page.getByTestId('backlinks-panel')).toBeVisible();
  await expect(page.getByTestId('backlink-Prop')).toHaveCount(0);

  // Reading never writes.
  expect(await fs.readFile(path.join(E2E_VAULT, 'Prop.md'), 'utf8')).toBe(PROP);
  expect(await fs.readFile(path.join(E2E_VAULT, 'Alpha.md'), 'utf8')).toBe(ALPHA);
});
