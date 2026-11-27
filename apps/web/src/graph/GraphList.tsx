import type { GraphNode } from "@gumply/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { pageHash } from "../lib/routing.js";
import { startupVaultPath } from "../lib/ui-state.js";
import type { GhostNode } from "./graph-model.js";

/**
 * #62tnekds: the graph as a list, for keyboard and screen-reader use (and anyone who'd rather read it). It lists
 * the pages the graph shows right now (the same search, chips and filters), most linked first, each as a link that
 * opens it; a page not created yet says so, and opening it creates it, as a click on its node does.
 *
 * Not virtualized on purpose: it's a list you open on purpose, and even 10,000 pages render once in ~100–200 ms.
 * Tag and attachment nodes (the graph's "extras") aren't pages and aren't listed.
 */
export function GraphList(props: {
  nodes: readonly GraphNode[];
  ghosts: readonly GhostNode[];
  label: string;
  testId: string;
  onOpenPage: (id: string) => void;
  onCreateGhost: (ghost: GhostNode) => void;
}) {
  const t = useT();
  const rows = useMemo(
    () =>
      [
        ...props.nodes.map((node) => ({ kind: "page" as const, id: node.id, title: node.title, links: node.linkCount, tag: node.tags[0], node })),
        ...props.ghosts.map((ghost) => ({ kind: "ghost" as const, id: ghost.id, title: ghost.title, links: ghost.refCount, tag: undefined, ghost })),
      ].sort((a, b) => b.links - a.links || a.title.localeCompare(b.title)),
    [props.nodes, props.ghosts],
  );
  if (rows.length === 0) {
    return (
      <p className="graph-list-empty" role="status" data-testid={`${props.testId}-empty`}>
        {t("graph.list.empty")}
      </p>
    );
  }
  return (
    <ul className="graph-list" aria-label={props.label} data-testid={props.testId}>
      {rows.map((row) => (
        <li key={row.id} className={`graph-list-row${row.kind === "ghost" ? " is-ghost" : ""}`}>
          {row.kind === "page" ? (
            <a
              href={pageHash(row.id)}
              className="graph-list-title"
              data-testid={`graph-list-item-${row.id}`}
              onClick={(event) => {
                // A modified or non-main click (new tab, new window) is the browser's.
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                props.onOpenPage(row.id);
              }}
            >
              {row.title}
            </a>
          ) : (
            // Creating a page is an action, not a place to go: a button, styled as the titles.
            <button type="button" className="graph-list-title" data-testid={`graph-list-item-${row.id}`} onClick={() => props.onCreateGhost(row.ghost)}>
              {row.title}
            </button>
          )}
          <span className="graph-list-meta">
            {row.kind === "ghost" ? `${t("graph.list.notCreated")} · ` : ""}
            {t("graph.links", { count: row.links })}
            {row.tag ? ` · #${row.tag}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The open vault's path (the list choice is per vault): known from start-up's health check, else fetched once.
 * Cached per window: switching vaults reloads the window (the desktop's openVault loads the new server's URL), so
 * this module starts afresh with the new vault.
 */
let vaultPathPromise: Promise<string> | null = null;
let vaultPathKnown: string | null = null;
function vaultPath(): Promise<string> {
  if (vaultPathKnown === null && startupVaultPath !== null) vaultPathKnown = startupVaultPath;
  if (vaultPathKnown !== null) return Promise.resolve(vaultPathKnown);
  vaultPathPromise ??= api.health().then(
    (health) => (vaultPathKnown = health.vaultPath ?? ""),
    () => (vaultPathKnown = ""),
  );
  return vaultPathPromise;
}

function readListMode(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/**
 * #62tnekds: whether the graph shows as a list, remembered per graph (global and local) and **per vault** (keyed by
 * the vault's path, @lead). It's this browser's view choice, so it lives in local storage, not in the vault's files.
 */
export function useGraphListMode(key: "global" | "local"): [boolean, (next: boolean) => void, boolean] {
  const storageKey = (vault: string) => `gumply:graph-list:${key}:${vault}`;
  if (vaultPathKnown === null && startupVaultPath !== null) vaultPathKnown = startupVaultPath;
  const [vault, setVault] = useState<string | null>(vaultPathKnown);
  const [on, setOn] = useState(() => (vaultPathKnown !== null ? readListMode(storageKey(vaultPathKnown)) : false));
  useEffect(() => {
    if (vault !== null) return;
    let live = true;
    void vaultPath().then((path) => {
      if (!live) return;
      setVault(path);
      setOn(readListMode(storageKey(path)));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);
  const set = useCallback(
    (next: boolean) => {
      setOn(next);
      try {
        const name = storageKey(vault ?? vaultPathKnown ?? "");
        if (next) window.localStorage.setItem(name, "1");
        else window.localStorage.removeItem(name);
      } catch {
        // Private mode: the choice lasts for this visit.
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vault, key],
  );
  // Ready once the vault is known: until then the caller shows nothing in the graph's place, so a list left on
  // never flashes the canvas first (@opus-editor).
  return [on, set, vault !== null];
}
