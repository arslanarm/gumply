/**
 * Typed client for the local API (wiki `spec/api`). Vite proxies `/api` to the
 * server, so paths are relative and work in dev and in e2e.
 */
import type { ApiError, Page, PageId, PageMeta } from "@gumply/core";

export class ApiRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined) headers.set("Content-Type", "application/json");

  const response = await fetch(`/api${path}`, { ...init, headers });

  if (!response.ok) {
    let message = response.statusText || `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as Partial<ApiError>;
      if (typeof body.error === "string" && body.error.length > 0) message = body.error;
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new ApiRequestError(response.status, message);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface CreatePageInput {
  title: string;
  parentId?: PageId | null;
  content?: string;
  icon?: string;
}

export interface UpdatePageInput {
  title?: string;
  content?: string;
  icon?: string;
  tags?: string[];
}

/** v1.1: a rename reports which other pages had their links rewritten (D12). */
export type UpdatePageResult = Page & { rewrittenPages?: PageId[] };

/** DELETE result: v1.1 returns a trash id; v1.0 returns 204 (no trash). */
export interface DeletePageResult {
  trashId: string | null;
  deleted: PageId[];
}

const pagePath = (id: PageId): string => `/pages/${encodeURIComponent(id)}`;

/**
 * All writes go through one queue. This guarantees ordering between a pending
 * autosave and a rename: the server's link rewrite (D12) must happen *after*
 * any in-flight stale content write, never before it.
 */
let mutationChain: Promise<void> = Promise.resolve();

function mutate<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationChain.then(task, task);
  mutationChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export const api = {
  listPages: (): Promise<PageMeta[]> => request("/pages"),

  getPage: (id: PageId): Promise<Page> => request(pagePath(id)),

  createPage: (input: CreatePageInput): Promise<Page> =>
    mutate(() => request("/pages", { method: "POST", body: JSON.stringify(input) })),

  updatePage: (id: PageId, patch: UpdatePageInput): Promise<UpdatePageResult> =>
    mutate(() =>
      request(pagePath(id), { method: "PUT", body: JSON.stringify(patch) }),
    ),

  deletePage: (id: PageId): Promise<DeletePageResult> =>
    mutate(async () => {
      const result = await request<{ trashId?: string; deleted?: PageId[] } | undefined>(
        pagePath(id),
        { method: "DELETE" },
      );
      if (!result) return { trashId: null, deleted: [id] };
      return { trashId: result.trashId ?? null, deleted: result.deleted ?? [id] };
    }),

  /** v1.1: restore a page (and its sub-pages) from the trash. */
  restoreTrash: (trashId: string): Promise<PageMeta[]> =>
    mutate(() => request(`/trash/${encodeURIComponent(trashId)}/restore`, { method: "POST" })),

  movePage: (id: PageId, parentId: PageId | null): Promise<Page> =>
    mutate(() =>
      request(`${pagePath(id)}/move`, {
        method: "POST",
        body: JSON.stringify({ parentId }),
      }),
    ),
};
