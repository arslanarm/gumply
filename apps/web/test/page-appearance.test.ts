import { describe, expect, it } from "vitest";
import {
  applyPageAppearance,
  followPageInStorage,
  loadLastPage,
  loadPageFont,
  loadPageWidth,
  loadStartupMode,
  loadStartupPage,
  remapPageId,
  saveLastPage,
  savePageFont,
  savePageWidth,
  saveStartupMode,
  saveStartupPage,
  startupTarget,
} from "../src/lib/page-appearance";

/** v0.9 F (#if236h9k): page font and width, and startup, per device (`gumply:*`). */

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

describe("page font and width", () => {
  it("default to Default and Normal, store only a choice that differs, and ignore junk", () => {
    const storage = memory();
    expect(loadPageFont(storage)).toBe("default");
    expect(loadPageWidth(storage)).toBe("normal");
    savePageFont("serif", storage);
    savePageWidth("full", storage);
    expect([loadPageFont(storage), loadPageWidth(storage)]).toEqual(["serif", "full"]);
    expect(storage.map.get("gumply:page-font")).toBe("serif");
    savePageFont("default", storage);
    expect(storage.map.has("gumply:page-font")).toBe(false);
    storage.setItem("gumply:page-width", "huge");
    expect(loadPageWidth(storage)).toBe("normal");
  });

  it("are written on the document root for CSS", () => {
    const root = { dataset: {} as DOMStringMap };
    applyPageAppearance("mono", "wide", root);
    expect(root.dataset).toEqual({ pageFont: "mono", pageWidth: "wide" });
  });
});

describe("startup", () => {
  it("keeps the mode per device and the chosen and last pages per vault", () => {
    const storage = memory();
    expect(loadStartupMode(storage)).toBe("last");
    saveStartupMode("daily", storage);
    expect(loadStartupMode(storage)).toBe("daily");
    saveStartupPage("/vaults/a", "Home", storage);
    saveStartupPage("/vaults/b", "Inbox", storage);
    saveLastPage("/vaults/a", "Notes/Plan", storage);
    expect(loadStartupPage("/vaults/a", storage)).toBe("Home");
    expect(loadStartupPage("/vaults/b", storage)).toBe("Inbox");
    expect(loadLastPage("/vaults/a", storage)).toBe("Notes/Plan");
    expect(loadLastPage("/vaults/b", storage)).toBeNull();
    saveStartupPage("/vaults/a", null, storage);
    expect(loadStartupPage("/vaults/a", storage)).toBeNull();
  });

  it("precedence: a new vault's welcome page, then the setting, then the default landing page", () => {
    const ids = new Set(["Welcome", "Home", "Plan"]);
    const base = { ids, newVaultPage: null, chosen: "Home", last: "Plan", fallback: "Welcome" };
    expect(startupTarget({ ...base, newVaultPage: "Welcome", mode: "daily" })).toEqual({ kind: "page", id: "Welcome" });
    expect(startupTarget({ ...base, mode: "daily" })).toEqual({ kind: "daily" });
    expect(startupTarget({ ...base, mode: "page" })).toEqual({ kind: "page", id: "Home" });
    expect(startupTarget({ ...base, mode: "last" })).toEqual({ kind: "page", id: "Plan" });
    // A chosen page that's gone falls back to the last one; a gone last page to the default.
    expect(startupTarget({ ...base, mode: "page", chosen: "Deleted" })).toEqual({ kind: "page", id: "Plan" });
    expect(startupTarget({ ...base, mode: "last", last: "Deleted" })).toEqual({ kind: "page", id: "Welcome" });
    expect(startupTarget({ ...base, mode: "last", last: null, fallback: null })).toEqual({ kind: "none" });
  });
});

describe("the stored pages follow renames and moves (#chbpc9yb)", () => {
  it("remapPageId: the page itself and its sub-pages; others unchanged", () => {
    expect(remapPageId("Notes/Plan", "Notes/Plan", "Notes/Roadmap")).toBe("Notes/Roadmap");
    expect(remapPageId("Notes/Plan/Week 1", "Notes/Plan", "Archive/Plan")).toBe("Archive/Plan/Week 1");
    expect(remapPageId("Notes/Planner", "Notes/Plan", "Notes/Roadmap")).toBe("Notes/Planner");
    expect(remapPageId("Other", "Notes/Plan", "Notes/Roadmap")).toBe("Other");
  });

  it("followPageInStorage: the chosen startup page and the last page, in this vault only", () => {
    const storage = memory();
    saveStartupPage("/vaults/a", "Notes/Plan", storage);
    saveLastPage("/vaults/a", "Notes/Plan/Week 1", storage);
    saveStartupPage("/vaults/b", "Notes/Plan", storage);
    expect(followPageInStorage("/vaults/a", "Notes/Plan", "Archive/Roadmap", storage)).toBe("Archive/Roadmap");
    expect(loadStartupPage("/vaults/a", storage)).toBe("Archive/Roadmap");
    expect(loadLastPage("/vaults/a", storage)).toBe("Archive/Roadmap/Week 1");
    expect(loadStartupPage("/vaults/b", storage)).toBe("Notes/Plan");
    // An unrelated rename changes nothing.
    expect(followPageInStorage("/vaults/a", "Elsewhere", "Moved", storage)).toBe("Archive/Roadmap");
  });
});
