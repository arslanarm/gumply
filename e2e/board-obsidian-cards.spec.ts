import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #jchhjepb (D39): a `text` node without Gumply data is drawn as Obsidian
 * draws it, a card (border and tint in its colour, normal text), on a board
 * Gumply hasn't written to. A Gumply board keeps its boxless text. The Text
 * tool marks new nodes; untouched nodes keep their bytes (D37).
 */

const OBSIDIAN =
  '{\n\t"nodes":[\n' +
  '\t\t{"id":"a1","type":"text","text":"Plain card","x":0,"y":0,"width":260,"height":80},\n' +
  '\t\t{"id":"b2","type":"text","text":"Green card","x":320,"y":0,"width":260,"height":80,"color":"4"}\n' +
  '\t],\n\t"edges":[]\n}';

async function openBoard(page: Page, request: APIRequestContext, name: string, json: string) {
  writeFileSync(path.join(E2E_VAULT, `${name}.canvas`), json);
  await expect
    .poll(async () => ((await (await request.get(`${API_URL}/api/pages`)).json()) as { id: string }[]).some((meta) => meta.id === `${name}.canvas`), { timeout: 10_000 })
    .toBe(true);
  await page.goto(`/#/${encodeURIComponent(`${name}.canvas`)}`);
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
}

const look = (page: Page, text: string) =>
  page.getByTestId('board-text').filter({ hasText: text }).evaluate((el) => {
    const cs = getComputedStyle(el);
    const body = getComputedStyle(document.body);
    return { card: el.getAttribute('data-card'), radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, color: cs.color, text: body.getPropertyValue('--text').trim(), background: cs.backgroundColor };
  });

test('a board made in Obsidian shows its text nodes as cards: border and tint in the colour, normal text', async ({ page, request, vault }) => {
  void vault;
  await openBoard(page, request, 'From Obsidian', OBSIDIAN);
  const plain = await look(page, 'Plain card');
  const green = await look(page, 'Green card');
  for (const card of [plain, green]) {
    expect(card.card).toBe('true');
    expect(card.radius).toBe('8px');
    expect(card.border).toBe('1px');
  }
  // Normal text colour on both (Obsidian doesn't colour a card's text).
  expect(green.color).toBe(plain.color);
  // The coloured card is tinted; the plain one isn't.
  expect(green.background).not.toBe(plain.background);
  await page.locator('.react-flow__nodes').screenshot({ path: test.info().outputPath('obsidian-cards.png') });
});

test('a Gumply board keeps boxless text; a new Text-tool node is marked and the others keep their bytes', async ({ page, request, vault }) => {
  void vault;
  // Gumply data on one node: this is a Gumply board.
  const gumply = OBSIDIAN.replace(
    '\t],',
    ',\n\t\t{"id":"s3","type":"text","text":"Sticky",\n\t\t\t"gumply":{"kind":"sticky"},\n\t\t\t"x":0,"y":200,"width":200,"height":200,"color":"3"}\n\t],',
  ).replace('"height":80,"color":"4"}\n,', '"height":80,"color":"4"},');
  writeFileSync(path.join(E2E_VAULT, 'Mine.canvas'), gumply);
  expect(JSON.parse(gumply).nodes).toHaveLength(3);
  await openBoard(page, request, 'Mine', gumply);
  expect((await look(page, 'Plain card')).card).toBeNull();
  expect((await look(page, 'Green card')).card).toBeNull();

  // The Obsidian board: add a text with the Text tool.
  await openBoard(page, request, 'From Obsidian', OBSIDIAN);
  const before = readFileSync(path.join(E2E_VAULT, 'From Obsidian.canvas'), 'utf8');
  await page.keyboard.press('t');
  const pane = (await page.locator('.react-flow__pane').boundingBox())!;
  await page.mouse.click(pane.x + pane.width - 150, pane.y + pane.height - 120);
  await page.keyboard.type('Typed here');
  await page.keyboard.press('Escape');
  await expect
    .poll(() => readFileSync(path.join(E2E_VAULT, 'From Obsidian.canvas'), 'utf8'), { timeout: 10_000 })
    .toContain('Typed here');
  const after = readFileSync(path.join(E2E_VAULT, 'From Obsidian.canvas'), 'utf8');
  // The new node is marked; the two Obsidian nodes are byte-identical lines.
  const added = JSON.parse(after).nodes.find((node: { text?: string }) => node.text === 'Typed here');
  expect(added.gumply).toEqual({ kind: 'text' });
  for (const line of before.split('\n').filter((l) => l.includes('"id":"a1"') || l.includes('"id":"b2"'))) {
    expect(after).toContain(line.replace(/,$/, ''));
  }
  // The new text is Gumply's boxless text; the cards stay cards (decided when the board opened).
  expect((await look(page, 'Typed here')).card).toBeNull();
  expect((await look(page, 'Green card')).card).toBe('true');
});
