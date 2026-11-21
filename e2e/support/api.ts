import type { APIRequestContext } from '@playwright/test';
import { API_URL } from './env';

/**
 * Thin client over the server API (wiki `spec/api`).
 * Tests seed and inspect data through this instead of clicking through the UI,
 * so a failing assertion points at the UI, not at test setup.
 */

export interface PageMeta {
  id: string;
  title: string;
  icon?: string;
  tags: string[];
  parentId: string | null;
  /** Direct sub-pages (spec/api v1.1) — used by the delete confirm. */
  childCount: number;
  created: string;
  updated: string;
}

export interface Page extends PageMeta {
  content: string;
}

export interface NewPage {
  title: string;
  parentId?: string | null;
  content?: string;
  icon?: string;
}

const api = (path: string) => `${API_URL}/api${path}`;

function assertOk(res: { ok(): boolean; status(): number; text(): Promise<string> }, what: string) {
  if (!res.ok()) {
    throw new Error(`${what} failed with ${res.status()}`);
  }
}

export async function listPages(request: APIRequestContext): Promise<PageMeta[]> {
  const res = await request.get(api('/pages'));
  assertOk(res, 'GET /pages');
  return res.json();
}

export async function createPage(request: APIRequestContext, page: NewPage): Promise<Page> {
  const res = await request.post(api('/pages'), { data: page });
  assertOk(res, `POST /pages (${page.title})`);
  return res.json();
}

export async function getPage(request: APIRequestContext, id: string): Promise<Page> {
  const res = await request.get(api(`/pages/${encodeURIComponent(id)}`));
  assertOk(res, `GET /pages/${id}`);
  return res.json();
}

export async function updatePage(
  request: APIRequestContext,
  id: string,
  patch: { title?: string; content?: string; icon?: string; tags?: string[] },
): Promise<Page & { rewrittenPages?: string[] }> {
  const res = await request.put(api(`/pages/${encodeURIComponent(id)}`), { data: patch });
  assertOk(res, `PUT /pages/${id}`);
  return res.json();
}

/** Move to `.trash/` (D11). Returns the trash id and every deleted id, subtree included. */
export async function deletePage(
  request: APIRequestContext,
  id: string,
): Promise<{ trashId: string; deleted: string[] } | null> {
  const res = await request.delete(api(`/pages/${encodeURIComponent(id)}`));
  // 404 = already gone, fine for fixture cleanup.
  if (res.status() === 404) return null;
  assertOk(res, `DELETE /pages/${id}`);
  // Tolerate the pre-v1.1 204 response while the server catches up: cleanup
  // only needs to know the page is gone, not the trash bookkeeping.
  const body = await res.text();
  return body ? (JSON.parse(body) as { trashId: string; deleted: string[] }) : { trashId: '', deleted: [id] };
}

/**
 * Undo for D11. v1.9 (#ppag3ugh): back where it was, or at the top level when
 * its folder page is gone; a taken name gets ` 2`.
 */
export async function restoreTrash(
  request: APIRequestContext,
  trashId: string,
): Promise<{ restored: PageMeta[]; id: string; movedToTopLevel: boolean; renamed: boolean }> {
  const res = await request.post(api(`/trash/${encodeURIComponent(trashId)}/restore`));
  assertOk(res, `POST /trash/${trashId}/restore`);
  return res.json();
}

export async function backlinks(request: APIRequestContext, id: string) {
  const res = await request.get(api(`/pages/${encodeURIComponent(id)}/backlinks`));
  assertOk(res, `GET /pages/${id}/backlinks`);
  return res.json() as Promise<{ page: PageMeta; snippet: string }[]>;
}

export async function graph(request: APIRequestContext, center?: string, depth?: number) {
  const qs = center ? `?center=${encodeURIComponent(center)}${depth ? `&depth=${depth}` : ''}` : '';
  const res = await request.get(api(`/graph${qs}`));
  assertOk(res, 'GET /graph');
  return res.json() as Promise<{
    nodes: (PageMeta & { linkCount: number })[];
    links: { source: string; target: string }[];
    tags: string[];
  }>;
}

export async function search(request: APIRequestContext, q: string) {
  const res = await request.get(api(`/search?q=${encodeURIComponent(q)}`));
  assertOk(res, 'GET /search');
  return res.json() as Promise<{ page: PageMeta; snippet: string; score: number }[]>;
}

/**
 * Wipe the vault so each test starts from a known state.
 * Deletes roots one by one (children cascade per spec).
 */
export async function resetVault(request: APIRequestContext): Promise<void> {
  const pages = await listPages(request);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const roots = pages.filter((p) => !p.parentId || !byId.has(p.parentId));
  for (const root of roots) {
    await deletePage(request, root.id);
  }
  const leftovers = await listPages(request);
  if (leftovers.length > 0) {
    throw new Error(
      `resetVault left ${leftovers.length} page(s): ${leftovers.map((p) => p.id).join(', ')}`,
    );
  }
  await emptyTrash(request);
}

/** v1.9 (#ppag3ugh): the trash, newest first. */
export async function listTrash(request: APIRequestContext) {
  const res = await request.get(api('/trash'));
  assertOk(res, 'GET /trash');
  return res.json() as Promise<
    Array<{ trashId: string; id: string; title: string; kind: string; children: Array<{ id: string; title: string }> }>
  >;
}

/** v1.9: delete every trash entry for good, so each test starts with an empty trash. */
export async function emptyTrash(request: APIRequestContext): Promise<void> {
  const res = await request.delete(api('/trash'));
  assertOk(res, 'DELETE /trash');
}
