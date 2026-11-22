/**
 * The MCP process's view of one vault (spec/mcp §1, §4): its own `VaultStore`
 * (the same single writer the app uses), plus what tools need on top:
 *
 * - **ids, never paths:** an id or title is resolved by the store's index;
 *   anything shaped like a path escape is refused before it is looked up, and
 *   a page whose real path is outside the vault (a symlink out) is refused;
 * - **freshness:** tools about one page check that page's file with one
 *   `stat` and re-read the vault only when it changed behind our back (the
 *   watcher may not have caught up yet).
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { resolveWikilink, type PageMeta } from "@gumply/core";
import { VaultStore } from "../../server/src/vault-store.js";
import { ToolError } from "./errors.js";

/**
 * The two private fields of a store record freshness needs. Read-only, in
 * this one place, so `apps/server` needn't grow an API for a second process.
 */
interface StoreRecordView {
  filePath: string;
  fileMtimeMs: number;
}
interface StoreInternals {
  pages: Map<string, StoreRecordView>;
}

export interface PageRef {
  id?: string | undefined;
  title?: string | undefined;
}

/** Ids that try to leave the vault, or name a dot folder: never looked up. */
function escapeKind(id: string): "outside" | "hidden" | null {
  if (id.includes("\0") || id.includes("\\")) return "outside";
  if (id.startsWith("/") || /^[A-Za-z]:/.test(id) || id.startsWith("~")) return "outside";
  const segments = id.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) return "outside";
  if (segments.some((segment) => segment.startsWith("."))) return "hidden";
  return null;
}

export class Vault {
  readonly store: VaultStore;
  private realRoot: string | null = null;
  /** Settles once the index is built; tool calls wait for it (the handshake doesn't). */
  ready: Promise<void> = Promise.resolve();

  constructor(readonly root: string) {
    // spec/version-history: what this store replaces is versioned as the AI app's.
    this.store = new VaultStore(root, { historySource: "mcp" });
  }

  /** Start reading the vault. The server answers the handshake meanwhile. */
  open(): Promise<void> {
    this.ready = (async () => {
      await this.store.init();
      this.realRoot = await realpath(this.store.root);
      this.store.startWatching();
    })();
    return this.ready;
  }

  close(): void {
    this.store.stopWatching();
  }

  private record(id: string): StoreRecordView | undefined {
    return (this.store as unknown as StoreInternals).pages.get(id);
  }

  /** Every page, board, folder and base the index holds. */
  list(): PageMeta[] {
    return this.store.list();
  }

  /**
   * Resolve exactly one of `id`/`title` to an index entry. Ids resolve as the
   * app does (exact, then case-insensitive); titles like `[[wikilinks]]`.
   * `fresh`: re-read the vault first if that page's file changed on disk, or
   * if it isn't known yet.
   */
  async resolve(ref: PageRef, options: { fresh?: boolean; field?: string } = {}): Promise<PageMeta> {
    const field = options.field ?? "id";
    const hasId = typeof ref.id === "string";
    const hasTitle = typeof ref.title === "string";
    if (hasId === hasTitle) throw new ToolError("INVALID_INPUT", "Pass exactly one of id or title.", { field: "id" });
    if (hasId) {
      const kind = escapeKind(ref.id!);
      if (kind === "outside") throw new ToolError("OUTSIDE_VAULT", "Ids are Gumply page ids inside the vault, not paths.", { field });
      if (kind === "hidden") throw new ToolError("NOT_FOUND", `No page or board with id "${ref.id}".`, { field });
    }
    const find = () => (hasId ? this.findById(ref.id!) : this.findByTitle(ref.title!));
    let found = find();
    if (options.fresh !== false) {
      if (found === null || (await this.changedOnDisk(found.id))) {
        await this.store.rescan();
        found = find();
      }
    }
    if (found === null) {
      throw new ToolError("NOT_FOUND", hasId ? `No page or board with id "${ref.id}".` : `No page or board titled "${ref.title}".`, { field: hasId ? field : "title" });
    }
    await this.assertInside(found.id);
    return found;
  }

  private findById(id: string): PageMeta | null {
    // An exact id: straight from the store, without building the whole list.
    if (this.record(id)) {
      try {
        const { content: _content, fileLinks: _links, properties: _props, ...meta } = this.store.get(id);
        return meta;
      } catch {
        try {
          return this.store.getBoard(id).meta;
        } catch {
          // A base or something else: the list below has it.
        }
      }
    }
    const pages = this.list();
    const exact = pages.find((page) => page.id === id);
    if (exact) return exact;
    const lower = id.toLowerCase();
    const loose = pages.filter((page) => page.id.toLowerCase() === lower);
    if (loose.length > 1) {
      throw new ToolError("AMBIGUOUS", `More than one item matches id "${id}".`, { candidates: loose.map((page) => page.id) });
    }
    return loose[0] ?? null;
  }

  private findByTitle(title: string): PageMeta | null {
    const pages = this.list().filter((page) => page.kind !== "folder");
    const wanted = title.trim().toLowerCase().replace(/\s+/g, " ");
    const same = pages.filter((page) => page.title.trim().toLowerCase().replace(/\s+/g, " ") === wanted);
    if (same.length > 1) {
      throw new ToolError("AMBIGUOUS", `More than one page is titled "${title}"; pass its id.`, {
        candidates: same.map((page) => ({ id: page.id, title: page.title })),
      });
    }
    // One title match, or a path/file-name link (`[[Folder/Note]]`), as the app resolves it.
    return same[0] ?? resolveWikilink(title, pages);
  }

  /** Whether the page's file changed (or went away) since the index read it. */
  async changedOnDisk(id: string): Promise<boolean> {
    const record = this.record(id);
    if (!record) return false; // A plain folder: nothing to stat.
    try {
      const info = await stat(record.filePath);
      return Math.abs(info.mtimeMs - record.fileMtimeMs) > 1;
    } catch {
      return true;
    }
  }

  /** Refuse a page whose real file is outside the vault (a symlink out). */
  async assertInside(id: string): Promise<void> {
    const record = this.record(id);
    if (!record || this.realRoot === null) return;
    let real: string;
    try {
      real = await realpath(record.filePath);
    } catch {
      throw new ToolError("NOT_FOUND", `No page or board with id "${id}".`);
    }
    if (!real.startsWith(this.realRoot + sep)) throw new ToolError("OUTSIDE_VAULT", "That item's file is outside the vault.");
  }

  /** Whether an index entry is listable (its file inside the vault). */
  async inside(id: string): Promise<boolean> {
    try {
      await this.assertInside(id);
      return true;
    } catch {
      return false;
    }
  }

  /** Vault-relative path of an item's file (null for plain folders). */
  pathOf(id: string): string | null {
    return this.store.vaultPathOf(id);
  }

  /** The exact bytes of an item's file now, or null if it has none. */
  async bytesOf(id: string): Promise<Buffer | null> {
    const record = this.record(id);
    if (!record) return null;
    try {
      return await readFile(record.filePath);
    } catch {
      return null;
    }
  }

  absolute(vaultPath: string): string {
    return join(this.store.root, ...vaultPath.split("/"));
  }
}
