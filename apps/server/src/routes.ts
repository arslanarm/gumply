import type {
  ApiError,
  Backlink,
  DeletePageResult,
  GraphData,
  Page,
  PageId,
  PageMeta,
  PageUpdateResult,
  SearchResult,
} from "@gumply/core";
import { Hono, type Context } from "hono";
import { badRequest } from "./errors.js";
import type { GraphOptions, UpdatePageInput, VaultStore } from "./vault-store.js";

type JsonObject = Record<string, unknown>;

async function readJson(c: Context): Promise<JsonObject> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("Request body must be a JSON object");
  }
  return body as JsonObject;
}

function optionalString(body: JsonObject, field: string): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined;
  const value = body[field];
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  return value;
}

function parentIdValue(body: JsonObject): PageId | null | undefined {
  if (!("parentId" in body) || body.parentId === undefined) return undefined;
  const value = body.parentId;
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest("parentId must be a string or null");
  return value;
}

function tagsValue(body: JsonObject): string[] | undefined {
  if (!("tags" in body) || body.tags === undefined) return undefined;
  const value = body.tags;
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw badRequest("tags must be an array of strings");
  }
  return value as string[];
}

function iconValue(body: JsonObject): string | null | undefined {
  if (!("icon" in body) || body.icon === undefined) return undefined;
  const value = body.icon;
  if (value === null || typeof value === "string") return value;
  throw badRequest("icon must be a string or null");
}

/** All `/api` routes; mounted by `createApp`. */
export function createApiRoutes(store: VaultStore): Hono {
  const api = new Hono();

  api.get("/pages", (c) => {
    const firstPage = store.consumeNewVaultPage();
    if (firstPage) c.header("X-Gumply-New-Vault", firstPage);
    return c.json<PageMeta[]>(store.list());
  });

  api.post("/pages", async (c) => {
    const body = await readJson(c);
    const page = await store.create({
      title: typeof body.title === "string" ? body.title : "",
      parentId: parentIdValue(body) ?? null,
      content: optionalString(body, "content") ?? "",
      icon: optionalString(body, "icon"),
    });
    return c.json<Page>(page, 201);
  });

  api.get("/pages/:id", (c) => c.json<Page>(store.get(c.req.param("id"))));

  api.put("/pages/:id", async (c) => {
    const body = await readJson(c);
    const patch: UpdatePageInput = {};

    const title = optionalString(body, "title");
    if (title !== undefined) patch.title = title;
    const content = optionalString(body, "content");
    if (content !== undefined) patch.content = content;
    const icon = iconValue(body);
    if (icon !== undefined) patch.icon = icon;
    const tags = tagsValue(body);
    if (tags !== undefined) patch.tags = tags;

    const result = await store.update(c.req.param("id"), patch);
    const { rewrittenPages, ...page } = result;
    return c.json<PageUpdateResult>(
      rewrittenPages.length > 0 ? { ...page, rewrittenPages } : page,
    );
  });

  api.delete("/pages/:id", async (c) => {
    const result = await store.remove(c.req.param("id"));
    return c.json<DeletePageResult>(result);
  });

  api.post("/trash/:trashId/restore", async (c) => {
    const restored = await store.restore(c.req.param("trashId"));
    return c.json<PageMeta[]>(restored);
  });

  api.post("/pages/:id/move", async (c) => {
    const body = await readJson(c);
    const parentId = parentIdValue(body);
    if (parentId === undefined) throw badRequest("parentId is required (use null for the root)");

    return c.json<Page>(await store.move(c.req.param("id"), parentId));
  });

  api.get("/pages/:id/backlinks", (c) => c.json<Backlink[]>(store.backlinks(c.req.param("id"))));

  api.get("/graph", (c) => {
    const centerQuery = c.req.query("center");
    const center = centerQuery === undefined || centerQuery === "" ? undefined : centerQuery;
    if (centerQuery === "") throw badRequest("center must not be empty");

    const depthQuery = c.req.query("depth");
    let depth: number | undefined;
    if (depthQuery !== undefined) {
      depth = Number(depthQuery);
      if (!Number.isInteger(depth)) throw badRequest("depth must be an integer");
    }

    const options: GraphOptions = { depth };
    if (center !== undefined) options.center = center;
    return c.json<GraphData>(store.graph(options));
  });

  api.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json<SearchResult[]>(store.search(q));
  });

  api.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  return api;
}
