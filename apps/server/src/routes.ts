import { readFile } from "node:fs/promises";
import type {
  ApiError,
  Attachment,
  Backlink,
  BoardDocument,
  BoardUpdateResult,
  DeletePageResult,
  GraphData,
  Page,
  PageId,
  PageMeta,
  PageUpdateResult,
  PropertiesPatch,
  PropertyInfo,
  PropertyType,
  RestoreResult,
  SearchResult,
  TrashedDocument,
  TrashItem,
  BaseViewResult,
} from "@gumply/core";
import { Hono, type Context } from "hono";
import {
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  resolveVaultFile,
  saveAttachment,
} from "./attachments.js";
import { badRequest, notFound, payloadTooLarge } from "./errors.js";
import { importAllowList, importRemoteImage } from "./remote-image.js";

// Tests only: host:port pairs the image import may reach on localhost.
const importAllow = importAllowList(process.env.GUMPLY_IMPORT_ALLOW);
import type {
  BaseDocument,
  GraphOptions,
  UpdateBaseInput,
  UpdateBoardInput,
  UpdatePageInput,
  VaultStore,
} from "./vault-store.js";
import { BaseQueries } from "./bases.js";
import { demoLanguageFor } from "./demo.js";

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

interface UploadedFile {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function isUploadedFile(value: unknown): value is UploadedFile {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as UploadedFile).name === "string" &&
    typeof (value as UploadedFile).size === "number" &&
    typeof (value as UploadedFile).arrayBuffer === "function"
  );
}

/** All `/api` routes; mounted by `createApp`. */
export function createApiRoutes(store: VaultStore): Hono {
  const bases = new BaseQueries(store);
  const api = new Hono();

  api.get("/pages", async (c) => {
    // #93yv3ban: a first run seeds the demo in the app's language first,
    // but only for the app's own fetch. A no-cors GET (`<img src>`, a
    // no-cors fetch) or a navigation carries no Origin, and a page elsewhere
    // could send one; Fetch Metadata tells them apart. An allow-list, so a
    // fetch mode browsers add later doesn't seed either. Tools without
    // Sec-Fetch-* headers (curl, tests) count as the app.
    const site = c.req.header("sec-fetch-site");
    const mode = c.req.header("sec-fetch-mode");
    const appRequest = (site === undefined || site === "same-origin") && (mode === undefined || mode === "cors");
    if (appRequest) await store.seedDemoOnFirstList(demoLanguageFor(c.req.header("accept-language")));
    const firstPage = appRequest ? store.consumeNewVaultPage() : null;
    // Percent-encoded: a header carries bytes, an id may be "Добро пожаловать".
    if (firstPage) c.header("X-Gumply-New-Vault", encodeURIComponent(firstPage));
    // v1.12: opt-in properties per page (database views); the default stays light.
    if (c.req.query("include") === "properties") return c.json(await store.listWithProperties());
    return c.json<PageMeta[]>(store.list());
  });

  api.post("/pages", async (c) => {
    const body = await readJson(c);
    const template = optionalString(body, "template");
    const page = await store.create({
      title: typeof body.title === "string" ? body.title : "",
      parentId: parentIdValue(body) ?? null,
      content: optionalString(body, "content") ?? "",
      icon: optionalString(body, "icon"),
      ...(template !== undefined ? { template } : {}),
    });
    return c.json<Page>(page, 201);
  });

  api.get("/pages/:id", async (c) => {
    const page = store.get(c.req.param("id"));
    return c.json<Page>({ ...page, properties: (await store.pageProperties(page.id)) ?? [] });
  });

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
    const expectedUpdated = optionalString(body, "expectedUpdated");
    if (expectedUpdated !== undefined) patch.expectedUpdated = expectedUpdated;
    if (body.force === true) patch.force = true;
    const writer = optionalString(body, "writer");
    if (writer !== undefined) patch.writer = writer.slice(0, 64);
    // v1.12 (D34): validated by the store against the page's frontmatter.
    if (body.properties !== undefined) patch.properties = body.properties as PropertiesPatch;

    const result = await store.update(c.req.param("id"), patch);
    const { rewrittenPages, ...rest } = result;
    // Pages carry their properties; a renamed folder (D33) has none.
    const properties = await store.pageProperties(rest.id);
    const page = properties === null ? rest : { ...rest, properties };
    return c.json<PageUpdateResult>(
      rewrittenPages.length > 0 ? { ...page, rewrittenPages } : page,
    );
  });

  // --- properties (v0.7 A, D34, spec/api v1.12) ---
  api.get("/properties", async (c) => c.json<PropertyInfo[]>(await store.listProperties()));

  api.put("/properties/:key", async (c) => {
    const body = await readJson(c);
    return c.json<PropertyInfo[]>(await store.setPropertyType(c.req.param("key"), body.type as PropertyType));
  });

  api.delete("/pages/:id", async (c) => {
    const result = await store.remove(c.req.param("id"));
    return c.json<DeletePageResult>(result);
  });

  // --- trash (D11; spec/api v1.9, #ppag3ugh) ---
  api.get("/trash", async (c) => c.json<TrashItem[]>(await store.listTrash()));

  api.get("/trash/:trashId", async (c) => {
    const id = c.req.query("id");
    return c.json<TrashedDocument>(await store.getTrashed(c.req.param("trashId"), id || undefined));
  });

  api.post("/trash/:trashId/restore", async (c) => {
    return c.json<RestoreResult>(await store.restore(c.req.param("trashId")));
  });

  api.delete("/trash/:trashId", async (c) => {
    await store.deleteTrashed(c.req.param("trashId"));
    return c.json({ deleted: 1 });
  });

  api.delete("/trash", async (c) => c.json({ deleted: await store.emptyTrash() }));

  // #9bx3aznb: every tag with its counts (the tags pane).
  api.get("/tags", (c) => c.json(store.tags()));

  // #9bx3aznb: rename a tag in every page and board.
  api.post("/tags/rename", async (c) => {
    const body = await readJson(c);
    const from = optionalString(body, "from");
    const to = optionalString(body, "to");
    if (from === undefined || to === undefined) throw badRequest("from and to are required");
    const skip = body.skip ?? [];
    if (!Array.isArray(skip) || skip.some((id) => typeof id !== "string")) throw badRequest("skip must be an array of ids");
    return c.json(await store.renameTag(from, to, skip as string[]));
  });

  // --- templates and daily notes (v0.7 C, spec/api-templates) ---
  api.get("/templates", async (c) => c.json(await store.listTemplates()));

  api.post("/pages/:id/template", async (c) => {
    const body = await readJson(c);
    const template = optionalString(body, "template");
    if (!template) throw badRequest("template is required");
    return c.json<Page>(await store.applyTemplate(c.req.param("id"), template));
  });

  api.get("/templates/render", async (c) => {
    const template = c.req.query("template");
    if (!template) throw badRequest("template is required");
    return c.json(await store.renderTemplateBody(template, c.req.query("title") ?? ""));
  });

  api.get("/daily/settings", async (c) => c.json(await store.dailySettings()));

  api.post("/daily", async (c) => {
    const body = await readJson(c);
    const date = optionalString(body, "date");
    if (!date) throw badRequest("date is required (YYYY-MM-DD)");
    const result = await store.dailyNote(date);
    return c.json(result, result.created ? 201 : 200);
  });

  api.post("/pages/:id/move", async (c) => {
    const body = await readJson(c);
    const parentId = parentIdValue(body);
    if (parentId === undefined) throw badRequest("parentId is required (use null for the root)");

    return c.json<Page>(await store.move(c.req.param("id"), parentId));
  });

  // --- whiteboards (D25, spec/api v1.7) ---
  api.post("/boards", async (c) => {
    const body = await readJson(c);
    const board = await store.createBoard({
      title: typeof body.title === "string" ? body.title : "",
      parentId: parentIdValue(body) ?? null,
      icon: optionalString(body, "icon"),
    });
    return c.json<BoardDocument>(board, 201);
  });

  api.get("/boards/:id", (c) => c.json<BoardDocument>(store.getBoard(c.req.param("id"))));

  api.put("/boards/:id", async (c) => {
    const body = await readJson(c);
    const patch: UpdateBoardInput = {};
    if (body.board !== undefined) patch.board = body.board;
    const title = optionalString(body, "title");
    if (title !== undefined) patch.title = title;
    const icon = iconValue(body);
    if (icon !== undefined) patch.icon = icon;
    const tags = tagsValue(body);
    if (tags !== undefined) patch.tags = tags;
    const expectedUpdated = optionalString(body, "expectedUpdated");
    if (expectedUpdated !== undefined) patch.expectedUpdated = expectedUpdated;
    if (body.force === true) patch.force = true;
    const writer = optionalString(body, "writer");
    if (writer !== undefined) patch.writer = writer.slice(0, 64);

    const { rewrittenPages, ...result } = await store.updateBoard(c.req.param("id"), patch);
    return c.json<BoardUpdateResult>(rewrittenPages.length > 0 ? { ...result, rewrittenPages } : result);
  });

  // --- database views (D34, spec/api-bases) ---
  api.post("/bases", async (c) => {
    const body = await readJson(c);
    const source = body.source && typeof body.source === "object" && !Array.isArray(body.source) ? (body.source as JsonObject) : {};
    const base = await store.createBase({
      title: typeof body.title === "string" ? body.title : "",
      parentId: parentIdValue(body) ?? null,
      source: {
        folder: typeof source.folder === "string" ? source.folder : null,
        ...(typeof source.tag === "string" ? { tag: source.tag } : {}),
      },
    });
    return c.json<BaseDocument>(base, 201);
  });

  api.get("/bases/:id", (c) => c.json<BaseDocument>(store.getBase(c.req.param("id"))));

  api.get("/bases/:id/view", async (c) => {
    const view = c.req.query("name");
    const thisId = c.req.query("this");
    return c.json<BaseViewResult>(
      await bases.run(c.req.param("id"), { ...(view ? { view } : {}), ...(thisId ? { thisId } : {}) }),
    );
  });

  api.put("/bases/:id", async (c) => {
    const body = await readJson(c);
    const patch: UpdateBaseInput = {};
    if (body.config !== undefined) patch.config = body.config;
    const title = optionalString(body, "title");
    if (title !== undefined) patch.title = title;
    const expectedUpdated = optionalString(body, "expectedUpdated");
    if (expectedUpdated !== undefined) patch.expectedUpdated = expectedUpdated;
    if (body.force === true) patch.force = true;
    const writer = optionalString(body, "writer");
    if (writer !== undefined) patch.writer = writer.slice(0, 64);
    const { rewrittenPages, ...result } = await store.updateBase(c.req.param("id"), patch);
    return c.json(rewrittenPages.length > 0 ? { ...result, rewrittenPages } : result);
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

  api.post("/attachments", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      throw badRequest("Attachment upload must be multipart/form-data with a `file` field");
    }

    const file = body["file"];
    if (!isUploadedFile(file)) throw badRequest("file is required");
    if (file.size > MAX_ATTACHMENT_BYTES) {
      throw payloadTooLarge("File is too large (max 25 MB)");
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const attachment = await saveAttachment(store.root, {
      name: file.name,
      data,
      mime: typeof body["mime"] === "string" ? body["mime"] : undefined,
    });
    return c.json<Attachment>(attachment, 201);
  });

  // "Save to vault" for a remote image (#w6i6e6u7): see remote-image.ts.
  api.post("/attachments/import", async (c) => {
    const body = await readJson(c);
    const url = body.url;
    if (typeof url !== "string" || url.trim().length === 0) throw badRequest("url is required");
    const attachment = await importRemoteImage(store.root, url.trim(), { allow: importAllow });
    return c.json<Attachment>(attachment, 201);
  });

  api.get("/attachments", async (c) => {
    return c.json<Attachment[]>(await listAttachments(store.root));
  });

  // #8k4ssrkb (spec/api-attachments-resolve): an Obsidian-style file link
  // typed after the page loaded. `from` is the note holding the link; an
  // unknown one resolves as from the vault root. Only linkable files come back
  // (allowlisted extensions, never dot folders); they're served by /files.
  api.get("/files/resolve", (c) => {
    const link = c.req.query("link") ?? "";
    if (!link.trim() || link.length > 1024) throw badRequest("link is required");
    const from = c.req.query("from");
    return c.json<{ path: string | null }>({ path: store.resolveFileLink(link, from && from.length <= 1024 ? from : null) });
  });

  api.get("/files/*", async (c) => {
    const prefix = "/api/files/";
    const raw = c.req.path.startsWith(prefix) ? c.req.path.slice(prefix.length) : "";
    const file = await resolveVaultFile(store.root, raw);
    if (!file) throw notFound("File not found");

    return c.body(await readFile(file.absolutePath), 200, {
      "Content-Type": file.mime,
      "Content-Length": String(file.size),
      // Attachment names are deduped and never overwritten; other vault files
      // (pages especially) change on every save and must not be cached.
      "Cache-Control": file.attachmentPath
        ? "private, max-age=31536000, immutable"
        : "no-cache",
      "X-Content-Type-Options": "nosniff",
      // An SVG or HTML file opened directly must not run script on our
      // origin (it still renders in <img>). Not for PDFs: a sandbox CSP
      // would block the browser's PDF viewer.
      ...(/^(image\/svg\+xml|text\/html)/.test(file.mime)
        ? { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" }
        : {}),
    });
  });

  api.notFound((c) => c.json<ApiError>({ error: "Not found" }, 404));

  return api;
}
