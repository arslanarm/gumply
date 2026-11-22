/**
 * Write tools (spec/mcp §3, A2). Listed only when the startup level allows
 * them; every call re-reads `.gumply/mcp.json`, so lowering the level in
 * Settings refuses the next call (`WRITES_DISABLED`) with no restart.
 *
 * Every write goes through the vault's `VaultStore` (D20 names, D22
 * conditional writes, header-key rule, D11 trash), saves the version it
 * replaces to `.gumply/history/` first, and adds one audit line.
 *
 * - `append`: create_page, append_to_page, add_to_board (only add);
 * - `edit`: also update_page, trash_page (both need the version the model read).
 */
import { randomBytes } from "node:crypto";
import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import { headingKey, linkTargetFor, pageHeadings, type CanvasNode, type PageMeta } from "@gumply/core";
import * as z from "zod";
import { VaultError } from "../../../server/src/errors.js";
import { audit } from "../audit.js";
import { ToolError } from "../errors.js";
import { saveVersion } from "../history.js";
import type { RateLimiter } from "../limits.js";
import { effectiveAccess, rank, readSettings, type Access } from "../settings.js";
import type { Vault } from "../vault.js";
import { kindOf, ok, tool } from "./common.js";

export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_APPEND_BYTES = 100 * 1024;

export interface WriteContext {
  vault: Vault;
  readOnly: boolean;
  limiter: RateLimiter;
  logMaxBytes: number;
  clientName: (meta: unknown) => string;
}

const ADD: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const CHANGE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const propertyValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]);

export function registerWriteTools(server: McpServer, ctx: WriteContext, startup: Access): void {
  const { vault } = ctx;
  const root = vault.store.root;
  const writer = `mcp-${process.pid}`;

  /** The level now (Settings may have lowered it), then the rate limit. */
  const guard = (required: Access) => {
    const settings = readSettings(root);
    if (!settings.enabled || rank(effectiveAccess(settings, ctx.readOnly)) < rank(required)) {
      throw new ToolError("WRITES_DISABLED", "Writing is turned off for this vault (Gumply → Settings → MCP).");
    }
  };
  const tooLarge = (text: string, max: number, field: string) => {
    if (Buffer.byteLength(text, "utf8") > max) throw new ToolError("TOO_LARGE", `${field} is over ${Math.round(max / 1024)} KB.`, { field });
  };
  /** Save the bytes about to be replaced (spec §4: before the write). */
  const snapshot = async (id: string, version: string, toolName: string, client: string, read?: Buffer | null) => {
    const bytes = read === undefined ? await vault.bytesOf(id) : read;
    if (!bytes) return;
    await saveVersion(root, { id, ext: id.endsWith(".canvas") ? "canvas" : "md", bytes, version, tool: toolName, client });
  };
  const pageOnly = (meta: PageMeta, hint: string) => {
    const kind = kindOf(meta);
    if (kind !== "page") throw new ToolError("UNSUPPORTED", kind === "whiteboard" ? `That's a board; ${hint}.` : `That's a ${kind}, not a page.`);
  };
  /** The store's 409 (the file changed under us) as CONFLICT with the version on disk now. */
  const conflictFrom = async (error: unknown, id: string): Promise<never> => {
    if (error instanceof VaultError && error.status === 409) {
      await vault.store.rescan();
      const now = vault.list().find((page) => page.id === id);
      throw new ToolError("CONFLICT", "The page changed since it was read; read it again.", { currentUpdated: now?.updated ?? null });
    }
    throw error;
  };

  tool(
    server,
    "create_page",
    {
      title: "Create a page",
      description:
        "Create a new page (optionally inside a folder or page, from a template). A taken name gets \" 2\". Not idempotent: retrying after a lost reply can make a second page.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        parentId: z.string().min(1).max(1000).nullable().optional(),
        content: z.string().optional(),
        template: z.string().min(1).max(1000).optional(),
      }),
      outputSchema: z.object({ id: z.string(), title: z.string(), updated: z.string(), link: z.string() }),
      annotations: ADD,
    },
    async ({ title, parentId, content, template }, client) => {
      guard("append");
      if (content !== undefined) tooLarge(content, MAX_BODY_BYTES, "content");
      let parent: string | null = null;
      if (parentId != null) {
        const meta = await vault.resolve({ id: parentId }, { field: "parentId" });
        const kind = kindOf(meta);
        if (kind !== "page" && kind !== "folder") throw new ToolError("UNSUPPORTED", `A page can't go inside a ${kind}.`, { field: "parentId" });
        parent = meta.id;
      }
      let templateId: string | undefined;
      if (template !== undefined) {
        const meta = await vault.resolve({ id: template }, { field: "template" });
        pageOnly(meta, "templates are pages");
        templateId = meta.id;
      }
      ctx.limiter.take();
      const page = await vault.store.create({ title, parentId: parent, ...(content !== undefined ? { content } : {}), ...(templateId ? { template: templateId } : {}) });
      // A new page has no previous version: its first history entry is the created one.
      await snapshot(page.id, page.updated, "create_page", client);
      await audit(root, { tool: "create_page", id: page.id, before: null, after: page.updated, client }, ctx.logMaxBytes);
      const target = linkTargetFor(page, vault.list());
      const link = `[[${target.target}${target.alias ? `|${target.alias}` : ""}]]`;
      return ok(
        { id: page.id, title: page.title, updated: page.updated, link },
        `Created "${page.title}" (id: ${page.id}). Link to it with ${link}. (Not idempotent: don't retry this call blindly.)`,
      );
    },
    ctx.clientName,
    vault.ready,
  );

  tool(
    server,
    "append_to_page",
    {
      title: "Append to a page",
      description:
        "Add Markdown at the end of a page, or at the end of one heading's section (to the next heading of the same or a higher level). Existing text is never changed.",
      inputSchema: z.object({ id: z.string().min(1).max(1000), markdown: z.string().min(1), underHeading: z.string().min(1).max(300).optional() }),
      outputSchema: z.object({ id: z.string(), updated: z.string() }),
      annotations: ADD,
    },
    async ({ id, markdown, underHeading }, client) => {
      guard("append");
      tooLarge(markdown, MAX_APPEND_BYTES, "markdown");
      const meta = await vault.resolve({ id });
      pageOnly(meta, "use add_to_board");
      ctx.limiter.take();
      // One retry if the file changes between our read and our write; then CONFLICT.
      for (let attempt = 0; ; attempt += 1) {
        const page = vault.store.get(meta.id);
        const next = appendMarkdown(page.content, markdown, underHeading);
        tooLarge(next, MAX_BODY_BYTES, "content");
        await snapshot(meta.id, page.updated, "append_to_page", client);
        try {
          const saved = await vault.store.update(meta.id, { content: next, expectedUpdated: page.updated, writer });
          await audit(root, { tool: "append_to_page", id: saved.id, before: page.updated, after: saved.updated, client }, ctx.logMaxBytes);
          return ok({ id: saved.id, updated: saved.updated }, `Appended to "${saved.title}" (id: ${saved.id}).`);
        } catch (error) {
          if (attempt >= 1 || !(error instanceof VaultError && error.status === 409)) await conflictFrom(error, meta.id);
          await vault.store.rescan();
        }
      }
    },
    ctx.clientName,
    vault.ready,
  );

  tool(
    server,
    "add_to_board",
    {
      title: "Add to a board",
      description: "Add one card to a whiteboard: a sticky note, a text card, a page card or a web link (http/https). It goes to the right of `near`, or below the board's content.",
      inputSchema: z.object({
        boardId: z.string().min(1).max(1000),
        item: z.discriminatedUnion("type", [
          z.object({ type: z.literal("sticky"), text: z.string().min(1), color: z.enum(["1", "2", "3", "4", "5", "6"]).optional() }),
          z.object({ type: z.literal("text"), text: z.string().min(1) }),
          z.object({ type: z.literal("page"), pageId: z.string().min(1).max(1000) }),
          z.object({ type: z.literal("link"), url: z.string().min(1).max(2000) }),
        ]),
        near: z.string().min(1).max(200).optional(),
      }),
      outputSchema: z.object({ boardId: z.string(), nodeId: z.string(), updated: z.string() }),
      annotations: ADD,
    },
    async ({ boardId, item, near }, client) => {
      guard("append");
      const meta = await vault.resolve({ id: boardId }, { field: "boardId" });
      if (kindOf(meta) !== "whiteboard") throw new ToolError("UNSUPPORTED", "That isn't a board; use append_to_page for pages.", { field: "boardId" });
      const doc = vault.store.getBoard(meta.id);
      let node: CanvasNode;
      const nodeId = randomBytes(8).toString("hex");
      const box = { id: nodeId, x: 0, y: 0 };
      if (item.type === "sticky" || item.type === "text") {
        tooLarge(item.text, MAX_APPEND_BYTES, "text");
        node =
          item.type === "sticky"
            ? { ...box, type: "text", text: item.text, width: 220, height: 220, color: item.color ?? "3", gumply: { kind: "sticky" } }
            : { ...box, type: "text", text: item.text, width: 300, height: 120 };
      } else if (item.type === "page") {
        const page = await vault.resolve({ id: item.pageId }, { field: "item.pageId" });
        const path = vault.pathOf(page.id);
        if (kindOf(page) === "folder" || !path) throw new ToolError("UNSUPPORTED", "A folder can't be a card.", { field: "item.pageId" });
        node = { ...box, type: "file", file: path, width: 400, height: 300 };
      } else {
        let url: URL | null = null;
        try {
          url = new URL(item.url);
        } catch {
          url = null;
        }
        if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
          throw new ToolError("INVALID_INPUT", "Only http and https links can go on a board.", { field: "item.url" });
        }
        node = { ...box, type: "link", url: url.href, width: 400, height: 240 };
      }
      const nodes = doc.board.nodes;
      if (near !== undefined) {
        const anchor = nodes.find((candidate) => candidate.id === near);
        if (!anchor) throw new ToolError("NOT_FOUND", `No card "${near}" on this board.`, { field: "near" });
        node.x = anchor.x + anchor.width + 40;
        node.y = anchor.y;
      } else if (nodes.length > 0) {
        node.x = Math.min(...nodes.map((candidate) => candidate.x));
        node.y = Math.max(...nodes.map((candidate) => candidate.y + candidate.height)) + 40;
      }
      ctx.limiter.take();
      // #3c86ify2: the file is read once; the history keeps exactly these bytes and the write patches them.
      const before = await vault.bytesOf(meta.id);
      await snapshot(meta.id, doc.meta.updated, "add_to_board", client, before);
      try {
        // A new board object: the store's copy is never mutated in place. Unknown keys stay (D25).
        // `minimal`: only the new node is added; the rest of the file keeps its bytes.
        const saved = await vault.store.updateBoard(meta.id, {
          board: { ...doc.board, nodes: [...nodes, node] },
          expectedUpdated: doc.meta.updated,
          writer,
          minimal: before ? { base: before.toString("utf8") } : true,
        });
        await audit(root, { tool: "add_to_board", id: saved.meta.id, before: doc.meta.updated, after: saved.meta.updated, client }, ctx.logMaxBytes);
        return ok({ boardId: saved.meta.id, nodeId, updated: saved.meta.updated }, `Added a ${item.type} card to "${saved.meta.title}" (node ${nodeId}).`);
      } catch (error) {
        return conflictFrom(error, meta.id);
      }
    },
    ctx.clientName,
    vault.ready,
  );

  if (rank(startup) < rank("edit")) return;

  tool(
    server,
    "update_page",
    {
      title: "Change a page",
      description:
        "Replace a page's content, or change its title, tags or properties. `expectedUpdated` must be the `updated` from your read: if the user changed the page since, you get CONFLICT and nothing is written. A new title renames the file and updates links to it. The replaced version is kept in history.",
      inputSchema: z.object({
        id: z.string().min(1).max(1000),
        expectedUpdated: z.string().min(1).max(100),
        content: z.string().optional(),
        title: z.string().min(1).max(200).optional(),
        tags: z.array(z.string().min(1).max(200)).max(200).optional(),
        properties: z
          .object({
            set: z.record(z.string(), propertyValue).optional(),
            remove: z.array(z.string()).optional(),
            rename: z.array(z.object({ from: z.string(), to: z.string() })).optional(),
          })
          .optional(),
      }),
      outputSchema: z.object({ id: z.string(), updated: z.string(), rewrittenPages: z.array(z.string()) }),
      annotations: CHANGE,
    },
    async ({ id, expectedUpdated, content, title, tags, properties }, client) => {
      guard("edit");
      if (content === undefined && title === undefined && tags === undefined && properties === undefined) {
        throw new ToolError("INVALID_INPUT", "Pass at least one of content, title, tags or properties.", { field: "content" });
      }
      if (content !== undefined) tooLarge(content, MAX_BODY_BYTES, "content");
      const meta = await vault.resolve({ id });
      pageOnly(meta, "boards can't be changed with update_page");
      const current = vault.store.get(meta.id);
      if (current.updated !== expectedUpdated) {
        throw new ToolError("CONFLICT", "The page changed since it was read; read it again.", { currentUpdated: current.updated });
      }
      ctx.limiter.take();
      await snapshot(meta.id, current.updated, "update_page", client);
      // A rename rewrites links in other pages too: keep their versions as well.
      if (title !== undefined && title.trim() !== current.title) {
        for (const link of vault.store.backlinks(meta.id)) await snapshot(link.page.id, link.page.updated, "update_page", client);
      }
      try {
        const saved = await vault.store.update(meta.id, {
          expectedUpdated,
          writer,
          ...(content !== undefined ? { content } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(properties !== undefined ? { properties } : {}),
        });
        await audit(root, { tool: "update_page", id: saved.id, before: current.updated, after: saved.updated, client }, ctx.logMaxBytes);
        const rewrittenPages = saved.rewrittenPages ?? [];
        return ok(
          { id: saved.id, updated: saved.updated, rewrittenPages },
          `Updated "${saved.title}" (id: ${saved.id}, updated: ${saved.updated})${rewrittenPages.length ? `; links updated in ${rewrittenPages.length} page(s)` : ""}.`,
        );
      } catch (error) {
        return conflictFrom(error, meta.id);
      }
    },
    ctx.clientName,
    vault.ready,
  );

  tool(
    server,
    "trash_page",
    {
      title: "Move to Trash",
      description:
        "Move a page or board, with its sub-pages, to Gumply's Trash, where the user can restore it. `expectedUpdated` must be the `updated` from your read. There is no way to delete for good.",
      inputSchema: z.object({ id: z.string().min(1).max(1000), expectedUpdated: z.string().min(1).max(100) }),
      outputSchema: z.object({ trashId: z.string(), deleted: z.array(z.string()) }),
      annotations: CHANGE,
    },
    async ({ id, expectedUpdated }, client) => {
      guard("edit");
      const meta = await vault.resolve({ id });
      const kind = kindOf(meta);
      if (kind === "folder") throw new ToolError("UNSUPPORTED", "Folders can't be trashed from here; trash the pages in it.");
      if (meta.updated !== expectedUpdated) {
        throw new ToolError("CONFLICT", "It changed since it was read; read it again.", { currentUpdated: meta.updated });
      }
      ctx.limiter.take();
      await snapshot(meta.id, meta.updated, "trash_page", client);
      // The store re-checks the file right before the move (the user may have saved meanwhile).
      if (await vault.changedOnDisk(meta.id)) {
        await vault.store.rescan();
        const now = vault.list().find((page) => page.id === meta.id);
        throw new ToolError("CONFLICT", "It changed since it was read; read it again.", { currentUpdated: now?.updated ?? null });
      }
      const result = await vault.store.remove(meta.id);
      await audit(root, { tool: "trash_page", id: meta.id, before: meta.updated, after: null, client }, ctx.logMaxBytes);
      return ok({ trashId: result.trashId, deleted: result.deleted }, `Moved "${meta.title}" and ${result.deleted.length - 1} sub-page(s) to the Trash (restorable).`);
    },
    ctx.clientName,
    vault.ready,
  );
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** Join `addition` after `before`, a blank line apart unless both are list items. */
function joinBlock(before: string, addition: string): string {
  const add = addition.replace(/\s+$/, "");
  if (before.trim() === "") return `${before}${add}\n`;
  const trimmed = before.replace(/\s+$/, "");
  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  const firstLine = add.split("\n", 1)[0] ?? "";
  const gap = LIST_ITEM.test(lastLine) && LIST_ITEM.test(firstLine) ? "\n" : "\n\n";
  // Every existing byte up to the last non-blank character stays as it was.
  return `${trimmed}${gap}${add}\n`;
}

/**
 * The page body with `markdown` added at the end, or at the end of the first
 * section under a heading matching `underHeading` (Obsidian sections: deeper
 * headings belong to it). Throws INVALID_INPUT, listing the headings, if none matches.
 */
export function appendMarkdown(content: string, markdown: string, underHeading?: string): string {
  if (underHeading === undefined) return joinBlock(content, markdown);
  const headings = pageHeadings(content);
  const wanted = headingKey(underHeading.replace(/^#+\s*/, ""));
  const index = headings.findIndex((heading) => headingKey(heading.text) === wanted);
  if (index === -1) {
    throw new ToolError("INVALID_INPUT", `No heading "${underHeading}" on this page.`, { field: "underHeading", headings: headings.map((heading) => heading.text) });
  }
  const heading = headings[index]!;
  const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
  if (!next) return joinBlock(content, markdown);
  const lines = content.split("\n");
  const head = lines.slice(0, next.line).join("\n");
  const tail = lines.slice(next.line).join("\n");
  const section = joinBlock(head, markdown);
  return `${section}\n${tail}`;
}
