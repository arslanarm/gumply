import fs from 'node:fs/promises';
import path from 'node:path';
import { api, expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/** #5fv7c25w: saving keeps the file's own final newline (LF, CRLF or none). */

const FILES = {
  Lf: 'Intro\n\nB\n',
  Crlf: 'Intro\r\n\r\nB\r\n',
  None: 'Intro\n\nB',
  Fm: '---\ntitle: Fm\n---\n\nIntro\n\nB\n',
} as const;

const file = (name: string) => path.join(E2E_VAULT, `${name}.md`);

for (const [name, text] of Object.entries(FILES)) {
  test(`an unrelated edit keeps the ending of a ${name} file`, async ({ page, request, vault }) => {
    void vault; // resets the vault before and after
    await fs.writeFile(file(name), text);
    await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain(name);
    await page.goto(`/#/${name}`);
    const body = page.getByTestId('editor-content');
    await body.getByText('Intro', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', { timeout: 10_000 });
    const after = await fs.readFile(file(name), 'utf8');
    const strip = (value: string) => value.replace(/^---[\s\S]*?---\r?\n/, '').replace(/^updated: .*$/m, '');
    expect(strip(after)).toBe(strip(text.replace('Intro', 'Intro edited')));
  });
}

test('opening a plain note never saves it', async ({ page, request, vault }) => {
  void vault;
  await fs.writeFile(file('Quiet'), 'Just reading\n');
  await expect.poll(async () => (await api.listPages(request)).map((meta) => meta.id)).toContain('Quiet');
  const before = (await fs.stat(file('Quiet'))).mtimeMs;
  await page.goto('/#/Quiet');
  await expect(page.getByTestId('editor-content')).toContainText('Just reading');
  await page.waitForTimeout(2500);
  expect((await fs.stat(file('Quiet'))).mtimeMs).toBe(before);
  expect(await fs.readFile(file('Quiet'), 'utf8')).toBe('Just reading\n');
});
