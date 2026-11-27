import type { GraphNode } from "@gumply/core";
import { useMemo } from "react";
import { useT } from "../i18n/index.js";
import { pageHash } from "../lib/routing.js";
import type { GhostNode } from "./graph-model.js";

/**
 * #62tnekds: the graph as a list, for keyboard and screen-reader use (and anyone who'd rather read it). It lists
 * the pages the graph shows right now (the same search, chips and filters), most linked first, each as a link that
 * opens it; a page not created yet says so, and opening it creates it, as a click on its node does.
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
  return (
    <ul className="graph-list" aria-label={props.label} data-testid={props.testId}>
      {rows.map((row) => (
        <li key={row.id} className={`graph-list-row${row.kind === "ghost" ? " is-ghost" : ""}`}>
          <a
            href={row.kind === "page" ? pageHash(row.id) : "#"}
            className="graph-list-title"
            data-testid={`graph-list-item-${row.id}`}
            onClick={(event) => {
              event.preventDefault();
              if (row.kind === "page") props.onOpenPage(row.id);
              else props.onCreateGhost(row.ghost);
            }}
          >
            {row.title}
          </a>
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
