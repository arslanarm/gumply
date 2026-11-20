import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #zvhhn84v: code blocks with a language picker, Copy and lazy syntax
 * highlighting. The language lives on the Markdown fence.
 */

async function waitSaved(page: Page) {
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved', {
    timeout: 10_000,
  });
}

const fileOf = (id: string) => fs.readFile(path.join(E2E_VAULT, `${id}.md`), 'utf8');

test('the picker sets the language: fence on disk, highlighted after reload', async ({ page, vault }) => {
  const [doc] = await vault.seed([
    { title: 'Snippets', content: 'Intro\n\n```\nconst answer: number = 42;\n```' },
  ]);
  await page.goto(`/#/${doc!.id}`);
  const block = page.getByTestId('code-block');
  await expect(block).toContainText('const answer');
  const button = block.getByTestId('code-language-button');
  await expect(button).toHaveText('Plain text');
  // Plain text is never highlighted.
  await expect(block.locator('[class*="hljs-"]')).toHaveCount(0);

  await button.click();
  await expect(page.getByTestId('code-language-search')).toBeFocused();
  await page.keyboard.type('typescr');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('code-language-picker')).toHaveCount(0);
  await expect(button).toHaveText('TypeScript');
  await expect(block.locator('.hljs-keyword').first()).toHaveText('const');
  await waitSaved(page);
  expect(await fileOf(doc!.id)).toMatch(/\n```ts\nconst answer: number = 42;\n```\n$/);

  await page.reload();
  await expect(page.getByTestId('code-language-button')).toHaveText('TypeScript');
  await expect(page.getByTestId('code-block').locator('.hljs-keyword').first()).toHaveText('const');
  await expect(page.getByTestId('code-block').locator('.hljs-number')).toHaveText('42');
});

test('typing ``` then a language name and Enter sets the language', async ({ page, vault }) => {
  const [doc] = await vault.seed([{ title: 'Typed fence', content: 'Start' }]);
  await page.goto(`/#/${doc!.id}`);
  await page.getByTestId('editor-content').getByText('Start').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```');
  // The block exists at once (nothing typed after ``` is eaten).
  await expect(page.getByTestId('code-block')).toHaveCount(1);
  await page.keyboard.type('python');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('code-language-button')).toHaveText('Python');
  await page.keyboard.type('def hi():');
  await page.keyboard.press('Enter');
  await page.keyboard.type('    return 1');
  await expect(page.getByTestId('code-block').locator('.hljs-keyword').first()).toHaveText('def');
  await waitSaved(page);
  expect(await fileOf(doc!.id)).toMatch(/Start\n\n```python\ndef hi\(\):\n {4}return 1\n```\n$/);
});

test('a "python" line in an existing code block stays code', async ({ page, vault }) => {
  const [doc] = await vault.seed([{ title: 'Not a fence', content: '```\nfirst\n```' }]);
  await page.goto(`/#/${doc!.id}`);
  await page.getByTestId('code-block').getByText('first').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('python');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('code-language-button')).toHaveText('Plain text');
  await waitSaved(page);
  expect(await fileOf(doc!.id)).toMatch(/```\nfirst\npython\n```/);
});

test('unknown languages from other apps are kept as written and shown as plain text', async ({
  page,
  vault,
}) => {
  const original = 'Top\n\n```dataviewjs title="x"\nconst pages = dv.pages();\n```';
  const [doc] = await vault.seed([{ title: 'Imported', content: original }]);
  await page.goto(`/#/${doc!.id}`);
  const block = page.getByTestId('code-block');
  await expect(block.getByTestId('code-language-button')).toHaveText('dataviewjs');
  await expect(block.locator('[class*="hljs-"]')).toHaveCount(0);

  // Edit elsewhere: the fence (with its extra words) is written back as is.
  await page.getByTestId('editor-content').getByText('Top').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' edited');
  await waitSaved(page);
  expect(await fileOf(doc!.id)).toMatch(/Top edited\n\n```dataviewjs title="x"\nconst pages = dv\.pages\(\);\n```\n$/);
});

test('Copy puts the code on the clipboard; Escape closes the picker back into the code', async ({
  page,
  context,
  vault,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const [doc] = await vault.seed([{ title: 'Copyable', content: '```json\n{ "a": 1 }\n```' }]);
  await page.goto(`/#/${doc!.id}`);
  const block = page.getByTestId('code-block');
  await block.hover();
  await block.getByTestId('code-copy').click();
  await expect(block.getByTestId('code-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{ "a": 1 }');

  await block.getByTestId('code-language-button').click();
  await expect(page.getByTestId('code-language-picker')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('code-language-picker')).toHaveCount(0);
  await expect(page.locator('.ProseMirror')).toBeFocused();
  await expect(block.getByTestId('code-language-button')).toHaveText('JSON');
});
