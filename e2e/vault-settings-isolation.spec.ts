import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';
import { API_URL, E2E_VAULT } from './support/env';

/**
 * #w284vn2u: a test that changes a vault-level setting (a property's type in the types file, here) must
 * not change what the next test sees. The shared `vault` fixture puts the settings files back as they
 * were when the worker started, before and after every test. These two cases run in file order: the
 * first sets `age` to Text, the second relies on the default (a page with `age: 31` reads it as a number).
 * Every name is invented.
 */
const typesFile = () => readFile(path.join(E2E_VAULT, '.gumply', 'types.json'), 'utf8').catch(() => null);
const typeOf = async (request: import('@playwright/test').APIRequestContext, key: string) => {
  const res = await request.get(`${API_URL}/api/properties`);
  expect(res.ok()).toBe(true);
  const list = (await res.json()) as Array<{ key: string; type: string }>;
  return list.find((info) => info.key === key)?.type;
};

test('a test may change a property type for itself (age → Text)', async ({ vault, request }) => {
  await vault.seed([{ title: 'Runner', content: '---\nage: 31\n---\nTraining log.' }]);
  const res = await request.put(`${API_URL}/api/properties/age`, { data: { type: 'text' } });
  expect(res.ok()).toBe(true);
  expect(await typeOf(request, 'age')).toBe('text');
  expect(await typesFile()).toContain('"age"');
});

test('the next test sees the vault settings as they were: age is a number again', async ({ vault, request }) => {
  await vault.seed([{ title: 'Climber', content: '---\nage: 27\n---\nRoute notes.' }]);
  expect(await typeOf(request, 'age')).toBe('number');
  expect(await typesFile() ?? '').not.toContain('"age"');
});
