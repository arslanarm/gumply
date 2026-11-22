import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * v0.8 C1 (#sipu2nxn, spec/api-mentions): "Unlinked mentions" under "Linked
 * from": Link one mention, then Link all, and the files' exact bytes.
 */

const NOTE = 'C1 Journal.md';
const file = (name: string) => path.join(E2E_VAULT, name);

test.afterEach(async () => {
  await rm(file(NOTE), { force: true });
});

test('Link and Link all turn plain mentions into links, byte for byte', async ({ page, vault }) => {
  await vault.seed([
    { title: 'Lighthouse', content: 'The page itself says Lighthouse.' },
    { title: 'Other', content: 'Nothing here.' },
  ]);
  // An Obsidian note (no frontmatter, CRLF) dropped into the vault.
  await writeFile(file(NOTE), 'Visited the lighthouse.\r\nThe Lighthouse was closed; `Lighthouse` in code.\r\n');
  const otherBefore = await readFile(file('Other.md'), 'utf8');
  await expect.poll(async () => (await vault.pages()).some((meta) => meta.title === 'C1 Journal'), { timeout: 5_000 }).toBe(true);

  await page.goto(`/#/${encodeURIComponent('Lighthouse')}`);
  const section = page.getByTestId('mentions-section');
  await expect(section.getByTestId('mentions-toggle')).toContainText('2');
  await section.getByTestId('mentions-toggle').click();
  const journal = section.getByTestId('mentions-C1 Journal');
  await expect(journal.getByTestId('mentions-link')).toHaveCount(2);

  // Link the second one only.
  await journal.getByTestId('mentions-link').nth(1).click();
  await expect.poll(() => readFile(file(NOTE), 'utf8'), { timeout: 5_000 }).toBe(
    'Visited the lighthouse.\r\nThe [[Lighthouse]] was closed; `Lighthouse` in code.\r\n',
  );
  // It is a backlink now, and one mention is left.
  await expect(page.getByTestId('backlink-C1 Journal')).toBeVisible();
  await expect(journal.getByTestId('mentions-link')).toHaveCount(1);

  await page.getByTestId('backlinks-panel').evaluate(() => undefined);
  await journal.getByTestId('mentions-link').click();
  await expect.poll(() => readFile(file(NOTE), 'utf8'), { timeout: 5_000 }).toBe(
    'Visited the [[Lighthouse|lighthouse]].\r\nThe [[Lighthouse]] was closed; `Lighthouse` in code.\r\n',
  );
  await expect(section.getByText('No unlinked mentions.')).toBeVisible();
  expect(await readFile(file('Other.md'), 'utf8')).toBe(otherBefore);
});

test('Link all links every mention in one page', async ({ page, vault }) => {
  await vault.seed([{ title: 'Lighthouse', content: 'x' }]);
  await writeFile(file(NOTE), 'lighthouse one, Lighthouse two, LIGHTHOUSE three\n');
  await expect.poll(async () => (await vault.pages()).some((meta) => meta.title === 'C1 Journal'), { timeout: 5_000 }).toBe(true);
  await page.goto(`/#/${encodeURIComponent('Lighthouse')}`);
  await page.getByTestId('mentions-toggle').click();
  await page.getByTestId('mentions-link-all').click();
  await expect.poll(() => readFile(file(NOTE), 'utf8'), { timeout: 5_000 }).toBe(
    '[[Lighthouse|lighthouse]] one, [[Lighthouse]] two, [[Lighthouse|LIGHTHOUSE]] three\n',
  );
});
