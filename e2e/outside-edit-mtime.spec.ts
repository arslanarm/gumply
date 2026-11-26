import { chmod, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { E2E_VAULT } from './support/env';

/**
 * #y5k39njn / #yy35bfac: an outside edit that keeps the frontmatter and an
 * older or equal file time (a sync tool keeping another device's mtime, a
 * clock behind, FAT's 2 s times) is still an outside change: a clean open
 * page shows it, and unsaved typing gets a conflict instead of overwriting
 * it (D22). A read-only vault folder keeps the typing and saves once it's
 * writable again. Synthetic vault.
 */

test.describe.configure({ timeout: 60_000 });

const file = (name: string) => path.join(E2E_VAULT, name);
const read = (name: string) => readFile(file(name), 'utf8');

async function openSaved(page: Page, vault: { seed: (pages: { title: string; content?: string }[]) => Promise<{ id: string }[]> }) {
  const [ledger] = await vault.seed([{ title: 'Ledger', content: 'Balance: ten.' }]);
  await page.goto(`/#/${encodeURIComponent(ledger!.id)}`);
  const body = page.getByTestId('editor-content');
  await body.getByText('Balance: ten.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Saved.');
  await expect.poll(() => read('Ledger.md')).toContain('Saved.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
  return body;
}

/** The other device's edit: the frontmatter kept, the file time set to `shift` ms from ours. */
async function outsideEdit(text: string, shift: number) {
  const bytes = await read('Ledger.md');
  const { mtime } = await stat(file('Ledger.md'));
  await writeFile(file('Ledger.md'), bytes.replace('Saved.', text));
  const when = new Date(mtime.getTime() + shift);
  await utimes(file('Ledger.md'), when, when);
}

for (const variant of [
  { name: 'the same file time', shift: 0, text: 'Other.' },
  { name: 'a file time 10 minutes earlier', shift: -10 * 60_000, text: 'Older-dated edit.' },
] as const) {
  test(`an outside edit with ${variant.name}: the clean open page shows it, and typing then saves after it`, async ({ page, vault }) => {
    const body = await openSaved(page, vault);
    await outsideEdit(variant.text, variant.shift);
    await expect(body).toContainText(variant.text, { timeout: 10_000 });
    await body.getByText(variant.text, { exact: false }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Mine.');
    await expect.poll(() => read('Ledger.md'), { timeout: 10_000 }).toContain(`${variant.text} Mine.`);
    await expect(page.getByTestId('save-status')).not.toHaveAttribute('data-state', 'conflict');
  });

  test(`an outside edit with ${variant.name} under unsaved typing: a conflict, never an overwrite`, async ({ page, vault }) => {
    await openSaved(page, vault);
    // The save of the next typing is held until the outside edit is on disk.
    let hold = true;
    await page.route('**/api/pages/Ledger', async (route) => {
      while (hold && route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 50));
      await route.continue();
    });
    await page.keyboard.type(' Mine.');
    await outsideEdit(variant.text, variant.shift);
    hold = false;
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'conflict', { timeout: 10_000 });
    expect(await read('Ledger.md')).toContain(variant.text);
    await expect(page.getByTestId('editor-content')).toContainText('Mine.');
  });
}

test('a read-only vault folder while typing: "Couldn\'t save", the typing kept, then saved once writable', async ({ page, vault }) => {
  const body = await openSaved(page, vault);
  await chmod(E2E_VAULT, 0o555);
  try {
    await page.keyboard.type(' Typed while locked.');
    await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'error', { timeout: 10_000 });
    await expect(body).toContainText('Typed while locked.');
  } finally {
    await chmod(E2E_VAULT, 0o755);
  }
  await expect.poll(() => read('Ledger.md'), { timeout: 20_000 }).toContain('Typed while locked.');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'saved');
});
