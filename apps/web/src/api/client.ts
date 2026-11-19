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

const pagePath = (id: PageId): string => `/pages/${encodeURIComponent(id)}`;

export const api = {
  listPages: (): Promise<PageMeta[]> => request("/pages"),

  getPage: (id: PageId): Promise<Page> => request(pagePath(id)),

  createPage: (input: CreatePageInput): Promise<Page> =>
    request("/pages", { method: "POST", body: JSON.stringify(input) }),

  updatePage: (id: PageId, patch: UpdatePageInput): Promise<Page> =>
    request(pagePath(id), { method: "PUT", body: JSON.stringify(patch) }),

  deletePage: (id: PageId): Promise<void> => request(pagePath(id), { method: "DELETE" }),

  movePage: (id: PageId, parentId: PageId | null): Promise<Page> =>
    request(`${pagePath(id)}/move`, { method: "POST", body: JSON.stringify({ parentId }) }),
};
