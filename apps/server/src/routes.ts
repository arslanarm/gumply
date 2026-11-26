import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ApiError,
  Attachment,
  Backlink,
  BoardDocument,
  ConflictKeep,
  BoardUpdateResult,
  DeletePageResult,
  GraphData,
  GraphSettingsResponse,
  LinkMentionsInput,
  LinkMentionsResult,
  PageMentions,
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
  VaultImage,
  LinkableFile,
} from "@gumply/core";
import { PAGE_LOOK_KEYS, formatImportLimit, indexGraphLinks, notionReportLanguage, type IndexedGraphData } from "@gumply/core";
import { Hono, type Context } from "hono";
import {
  listAttachments,
  MAX_ATTACHMENT_BYTES,
  resolveVaultFile,
  saveAttachment,
} from "./attachments.js";
import { badRequest, notFound, payloadTooLarge } from "./errors.js";
import { readGraphSettings, writeGraphSettings } from "./graph-settings.js";
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
import { NOTION_IMPORT_LIMITS, NotionImports, type NotionImportJob } from "./notion-import.js";
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

/** #3ht5gh6q: image files the cover picker offers; #4usgpjh8 caps both lists. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const MAX_LISTED_FILES = 2000;

/**
 * Files from the #8k4ssrkb index (never dot folders, `.trash`, `.gumply` or
 * `node_modules`) that pass `keep`: newest first, then by path, capped.
 */
async function listVaultFiles(store: VaultStore, keep: (path: string) => boolean): Promise<VaultImage[]> {
  const found = await Promise.all(
    store.fileIndex
      .paths()
      .filter(keep)
      .map(async (path) => {
        try {
          const info = await stat(join(store.root, path));
          return info.isFile() ? { path, time: info.mtimeMs } : null;
        } catch {
          return null;
        }
      }),
  );
  return found
    .filter((item): item is { path: string; time: number } => item !== null)
    .sort((a, b) => b.time - a.time || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, MAX_LISTED_FILES)
    .map(({ path, time }) => ({ path, name: path.slice(path.lastIndexOf("/") + 1), modified: new Date(time).toISOString() }));
}

/** All `/api` routes; mounted by `createApp`. */
export function createApiRoutes(store: VaultStore): Hono {
  const bases = new BaseQueries(store);
  const imports = new NotionImports(store);
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
    // #jxww67d9 (spec/api v1.24): the linkable-files version; when it moves, the client asks
    // again about file links that had no file.
    c.header("X-Gumply-Files", String(store.fileIndexVersion));
    // v1.29 (spec/sync-conflicts §8): a sync tool is changing many files right now.
    if (store.syncing) c.header("X-Gumply-Syncing", "1");
    // v1.33 (#g95wkd9y): the links of a vault just opened are still being indexed.
    if (store.indexing) c.header("X-Gumply-Indexing", "1");
    // v1.35 (#xgnvipyd): renames whose link rewrite is still running, so a click on
    // an `[[Old]]` link not yet rewritten opens the renamed page (JSON, percent-encoded).
    const renames = store.renamesInProgress;
    if (renames.length > 0) c.header("X-Gumply-Renaming", encodeURIComponent(JSON.stringify(renames)));
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
  // The page cover and background (#385sexd6) are the page's look, not properties to suggest.
  api.get("/properties", async (c) =>
    c.json<PropertyInfo[]>((await store.listProperties()).filter((info) => !PAGE_LOOK_KEYS.includes(info.key))),
  );

  api.put("/properties/:key", async (c) => {
    const body = await readJson(c);
    return c.json<PropertyInfo[]>(await store.setPropertyType(c.req.param("key"), body.type as PropertyType, { ifAbsent: body.ifAbsent === true }));
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

  // --- version history (spec/version-history §7, D41; spec/api v1.28) ---
  api.get("/history/:id", async (c) => {
    const limit = Number(c.req.query("limit") ?? "");
    const cursor = c.req.query("cursor");
    return c.json(
      await store.listHistory(c.req.param("id"), {
        ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
        ...(cursor ? { cursor } : {}),
      }),
    );
  });

  api.get("/history/:id/:file", async (c) => {
    const { bytes, kind } = await store.readVersion(c.req.param("id"), c.req.param("file"));
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": kind === "whiteboard" ? "application/json; charset=utf-8" : kind === "base" ? "text/yaml; charset=utf-8" : "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  api.get("/history/:id/:file/diff", async (c) =>
    c.json(await store.diffVersion(c.req.param("id"), c.req.param("file"), c.req.query("against") || "current")),
  );

  api.post("/history/:id/:file/restore", async (c) => {
    const body = await readJson(c);
    const expectedUpdated = optionalString(body, "expectedUpdated");
    const writer = optionalString(body, "writer");
    // spec/api v1.34: why the restore happens. Only "undo-keep-copy" (a conflict's Keep copy, undone).
    const why = optionalString(body, "why");
    if (why !== undefined && why !== "undo-keep-copy") throw badRequest('why must be "undo-keep-copy"');
    const result = await store.restoreVersion(c.req.param("id"), c.req.param("file"), {
      ...(expectedUpdated !== undefined ? { expectedUpdated } : {}),
      ...(writer !== undefined ? { writer: writer.slice(0, 64) } : {}),
      ...(why === "undo-keep-copy" ? { undid: "keep-copy" as const } : {}),
    });
    if ("board" in result) return c.json<BoardDocument>(result);
    // N1 (#kw8th869): a database view's restore answers its document.
    if ("config" in result) return c.json<BaseDocument>(result);
    return c.json<Page>({ ...result, properties: (await store.pageProperties(result.id)) ?? [] });
  });

  api.put("/history/:id/:file/pin", async (c) => {
    const body = await readJson(c);
    if (typeof body.pinned !== "boolean") throw badRequest("pinned must be true or false");
    return c.json(await store.pinVersion(c.req.param("id"), c.req.param("file"), body.pinned));
  });

  // The page was closed: its editing session ends now (D41 rule 6).
  api.post("/history/:id/checkpoint", async (c) => c.json({ saved: await store.checkpoint(c.req.param("id")) }));

  // spec/api v1.34 (#chbpc9yb): keep text about to be dropped (a save conflict's
  // Reload) as a `before-reload` version. Same trust level and input limits as
  // `PUT /pages/:id`; it never writes the page file.
  api.post("/history/:id/unsaved", async (c) => {
    const body = await readJson(c);
    const item = await store.saveUnsavedVersion(c.req.param("id"), { content: body.content, board: body.board });
    return item ? c.json({ file: item.file, at: item.at }, 201) : c.json({ saved: false });
  });

  api.get("/history-orphans", async (c) => c.json(await store.historyOrphans()));

  api.post("/history-orphans/:key/restore", async (c) => {
    const body = await readJson(c);
    const file = optionalString(body, "file");
    const result = await store.restoreOrphan(c.req.param("key"), file);
    if ("board" in result || "config" in result) return c.json(result, 201);
    return c.json({ ...result, properties: (await store.pageProperties(result.id)) ?? [] }, 201);
  });

  api.get("/history-usage", async (c) => c.json(await store.historyUsage()));

  api.delete("/history-usage", async (c) => {
    const days = Number(c.req.query("olderThan") ?? "");
    if (!Number.isFinite(days) || days < 0) throw badRequest("olderThan must be a number of days");
    return c.json(await store.clearHistory(days * 86_400_000));
  });

  // --- sync conflict copies (spec/sync-conflicts, D43; spec/api v1.29) ---
  api.get("/conflicts", async (c) => c.json(await store.conflicts()));

  api.get("/conflicts/:id/diff", async (c) => c.json(await store.conflictDiff(c.req.param("id"))));

  api.post("/conflicts/:id/resolve", async (c) => {
    const body = await readJson(c);
    const expected = body.expected as { page?: unknown; copy?: unknown } | undefined;
    if (typeof expected !== "object" || expected === null || typeof expected.copy !== "string") throw badRequest("expected.copy is required");
    if (expected.page !== undefined && typeof expected.page !== "string") throw badRequest("expected.page must be a string");
    return c.json(
      await store.resolveConflict(c.req.param("id"), {
        keep: body.keep as ConflictKeep,
        expected: { copy: expected.copy, ...(typeof expected.page === "string" ? { page: expected.page } : {}) },
      }),
    );
  });

  // Undo of Keep both / Keep as original: back to the conflict-copy name.
  api.post("/conflicts/:id/rename-back", async (c) => {
    const body = await readJson(c);
    const to = optionalString(body, "to");
    if (!to) throw badRequest("to is required");
    return c.json(await store.undoConflictRename(c.req.param("id"), to));
  });

  api.post("/conflicts/:id/dismiss", async (c) => {
    await store.dismissPossibleCopy(c.req.param("id"), true);
    return c.json({ dismissed: true });
  });

  api.delete("/conflicts/:id/dismiss", async (c) => {
    await store.dismissPossibleCopy(c.req.param("id"), false);
    return c.json({ dismissed: false });
  });

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
      ...(body.rows === true ? { rows: true } : {}),
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

  // #7prbquxu: rename or delete a property in every row of an owned database (all or nothing for a rename).
  api.post("/bases/:id/rows-property", async (c) => {
    const body = await readJson(c);
    const options: { expectedUpdated?: string; writer?: string } = {};
    const expectedUpdated = optionalString(body, "expectedUpdated");
    if (expectedUpdated !== undefined) options.expectedUpdated = expectedUpdated;
    const writer = optionalString(body, "writer");
    if (writer !== undefined) options.writer = writer.slice(0, 64);
    const rename = body.rename as { from?: unknown; to?: unknown } | undefined;
    if (rename && typeof rename === "object" && typeof rename.from === "string" && typeof rename.to === "string") {
      return c.json(await store.changeOwnedRowsProperty(c.req.param("id"), { rename: { from: rename.from, to: rename.to } }, options));
    }
    if (typeof body.remove === "string") return c.json(await store.changeOwnedRowsProperty(c.req.param("id"), { remove: body.remove }, options));
    throw badRequest("expected rename: {from, to} or remove: <key>");
  });

  // #g95wkd9y: links are complete once the background index is done.
  api.get("/pages/:id/backlinks", async (c) => {
    await store.whenIndexed();
    return c.json<Backlink[]>(store.backlinks(c.req.param("id")));
  });

  // v1.21 (C1, spec/api-mentions): unlinked mentions, and turning them into links.
  api.get("/pages/:id/mentions", async (c) => c.json<PageMentions[]>(await store.mentions(c.req.param("id"))));

  api.post("/pages/:id/mentions/link", async (c) => {
    const body = await readJson(c);
    return c.json<LinkMentionsResult>(await store.linkMentions(c.req.param("id"), body as unknown as LinkMentionsInput));
  });

  api.get("/graph", async (c) => {
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
    // v1.19 (E1): `include=attachments` adds each page's attachment links.
    const include = (c.req.query("include") ?? "").split(",").map((item) => item.trim());
    if (include.includes("attachments")) options.attachments = true;
    // v1.32 (#g95wkd9y): `links=index` sends links as [sourceIndex, targetIndex]
    // into `nodes` (11 MB → ~1 MB on a 10k vault). The default is unchanged.
    await store.whenIndexed();
    const graph = store.graph(options);
    if (c.req.query("links") === "index") return c.json<IndexedGraphData>(indexGraphLinks(graph));
    return c.json<GraphData>(graph);
  });

  // v1.19 (E1, spec/api-graph-groups): colour groups and filters, per vault.
  api.get("/graph/settings", async (c) => c.json<GraphSettingsResponse>(await readGraphSettings(store.root)));

  api.put("/graph/settings", async (c) => {
    const body = await readJson(c);
    return c.json<GraphSettingsResponse>(await writeGraphSettings(store.root, body));
  });

  // D13; v1.31 (#g95wkd9y): one page of results (`limit`, default 50, at most 200),
  // the next page's `cursor` in `X-Next-Cursor`. The body stays an array.
  api.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Number(c.req.query("limit") ?? "");
    const cursor = c.req.query("cursor");
    const { items, nextCursor } = store.searchPage(q, {
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (nextCursor) c.header("X-Next-Cursor", nextCursor);
    return c.json<SearchResult[]>(items);
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
    store.fileSaved(attachment.path);
    return c.json<Attachment>(attachment, 201);
  });

  // "Save to vault" for a remote image (#w6i6e6u7): see remote-image.ts.
  api.post("/attachments/import", async (c) => {
    const body = await readJson(c);
    const url = body.url;
    if (typeof url !== "string" || url.trim().length === 0) throw badRequest("url is required");
    const attachment = await importRemoteImage(store.root, url.trim(), { allow: importAllow });
    store.fileSaved(attachment.path);
    return c.json<Attachment>(attachment, 201);
  });

  // v0.8 B2 (#znyztw3t, spec/api-import): import a Notion "Markdown & CSV" export.
  api.post("/import/notion", async (c) => {
    const length = Number(c.req.header("content-length") ?? Number.NaN);
    if (length > NOTION_IMPORT_LIMITS.uploadBytes) throw payloadTooLarge(`The export is too large (max ${formatImportLimit(NOTION_IMPORT_LIMITS.uploadBytes)})`);
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch {
      throw badRequest("The import must be multipart/form-data with a `file` field");
    }
    const file = body["file"];
    if (!isUploadedFile(file)) throw badRequest("file is required");
    if (file.size > NOTION_IMPORT_LIMITS.uploadBytes) throw payloadTooLarge(`The export is too large (max ${formatImportLimit(NOTION_IMPORT_LIMITS.uploadBytes)})`);
    const parent = body["parentId"];
    const parentId = typeof parent === "string" && parent.length > 0 ? parent : null;
    // #n86gnptg: `Import report.md` in the app's language (unknown → English).
    const language = notionReportLanguage(body["language"]);
    const job = imports.start(new Uint8Array(await file.arrayBuffer()), parentId, language);
    return c.json<NotionImportJob>(job, 202);
  });

  api.get("/import/:job", (c) => {
    const job = imports.get(c.req.param("job"));
    if (!job) throw notFound("No such import");
    return c.json<NotionImportJob>(job);
  });

  api.get("/attachments", async (c) => {
    return c.json<Attachment[]>(await listAttachments(store.root));
  });

  // #3ht5gh6q: every image in the vault (the cover picker), from the
  // #8k4ssrkb file index: never dot folders, `.trash` or `.gumply`. Newest
  // first, then by path; read-only.
  api.get("/files/images", async (c) => {
    return c.json<VaultImage[]>(await listVaultFiles(store, (path) => IMAGE_FILE.test(path)));
  });

  // #4usgpjh8: every linkable file (the `![[` menu), each with the link text
  // Obsidian would write for it from the note `from` (bare name when that
  // resolves back to it, else the full path).
  api.get("/files/linkable", async (c) => {
    const from = c.req.query("from");
    const note = from && from.length <= 1024 ? from : null;
    const files = await listVaultFiles(store, () => true);
    return c.json<LinkableFile[]>(files.map((file) => ({ ...file, link: store.linkTextFor(file.path, note) })));
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
