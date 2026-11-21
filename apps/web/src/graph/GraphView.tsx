import type { GraphData, PageId } from "@gumply/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiRequestError } from "../api/client.js";
import { Icon } from "../components/Icon.js";
import { GraphCanvas, type CanvasNode } from "./GraphCanvas.js";
import {
  ariaSummary,
  buildGraphModel,
  filterGraph,
  graphSubtitle,
  paletteIndex,
  type GhostNode,
} from "./graph-model.js";
import { normaliseIcon } from "./emoji-sprites.js";
import { usePrefersReducedMotion } from "./use-reduced-motion.js";
import "./graph.css";
import { t, useT } from "../i18n/index.js";

export interface GraphViewProps {
  /** Page to highlight when arriving from a page view. */
  highlightId: PageId | null;
  onOpenPage: (id: PageId) => void;
  /** Create the page for a ghost node, then open it. */
  onCreatePage: (title: string) => Promise<void>;
  /** Create a page from the empty state. */
  onNewPage: () => void;
}

type Status = "loading" | "ready" | "error";

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && /fetch|network|load failed/i.test(error.message)) {
    return t("graph.serverDown");
  }
  return t("graph.loadFailed");
}

/** Global graph view at `#graph` (spec/ux §9, D16). */
export function GraphView({ highlightId, onOpenPage, onCreatePage, onNewPage }: GraphViewProps) {
  const t = useT();
  const [data, setData] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [legendOpen, setLegendOpen] = useState(true);
  const reducedMotion = usePrefersReducedMotion();

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const graph = await api.getGraph();
      setData(graph);
      setStatus("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const model = useMemo(() => (data ? buildGraphModel(data) : null), [data]);
  const filtered = useMemo(
    () => (model ? filterGraph(model, { query, tags: selectedTags }) : null),
    [model, query, selectedTags],
  );

  // Stable arrays: a new identity on every render would restart the force
  // simulation (and the auto-fit) on unrelated state changes such as hovering.
  const canvasNodes = useMemo<CanvasNode[]>(
    () => (filtered ? [...filtered.nodes, ...filtered.ghosts] : []),
    [filtered],
  );
  const canvasLinks = useMemo(() => filtered?.links ?? [], [filtered]);

  const toggleTag = (tag: string) => {
    setSelectedTags((previous) =>
      previous.includes(tag) ? previous.filter((item) => item !== tag) : [...previous, tag],
    );
  };

  const clearFilters = () => {
    setQuery("");
    setSelectedTags([]);
  };

  const createGhost = (ghost: GhostNode) => {
    setActionError(null);
    onCreatePage(ghost.title).catch((caught: unknown) => setActionError(errorMessage(caught)));
  };

  const hasPages = (data?.nodes.length ?? 0) > 0;
  // Legend row for emoji nodes, only when some page actually has an icon;
  // shows one of the vault's own icons as the sample.
  const sampleIcon = useMemo(() => {
    for (const node of data?.nodes ?? []) {
      const icon = normaliseIcon(node.icon);
      if (icon) return icon;
    }
    return null;
  }, [data]);
  const hasBoards = useMemo(() => (data?.nodes ?? []).some((node) => node.kind === "whiteboard"), [data]);
  const hasVisible = (filtered?.nodes.length ?? 0) + (filtered?.ghosts.length ?? 0) > 0;
  const filtersActive = query.trim().length > 0 || selectedTags.length > 0;

  return (
    <section className="graph-view" aria-label={t("graph.title")}>
      <header className="graph-header">
        <div>
          <h2>{t("graph.title")}</h2>
          <p className="graph-subtitle" data-testid="graph-subtitle">
            {hasPages && data && filtered ? graphSubtitle(filtered) : t("graph.subtitle")}
          </p>
        </div>
        <div className="graph-toolbar">
          {hasPages ? (
            <>
              <div className="graph-filter-wrap">
                <Icon name="search" size={14} className="graph-filter-icon" />
                <input
                  className="graph-filter"
                  data-testid="graph-filter"
                  type="search"
                  placeholder={t("graph.filterPlaceholder")}
                  aria-label={t("graph.filterLabel")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query) {
                      event.preventDefault();
                      setQuery("");
                    }
                  }}
                />
                {query ? (
                  <button
                    type="button"
                    className="graph-filter-clear"
                    data-testid="graph-filter-clear"
                    aria-label={t("graph.clearFilter")}
                    data-tooltip={t("graph.clearFilter")}
                    onClick={() => setQuery("")}
                  >
                    <Icon name="x" size={14} />
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className={`button-secondary graph-legend-toggle${legendOpen ? " is-active" : ""}`}
                aria-expanded={legendOpen}
                aria-controls="graph-legend"
                onClick={() => setLegendOpen((value) => !value)}
              >
                {t("graph.legend")}
              </button>
            </>
          ) : null}
        </div>
      </header>

      {actionError ? (
        <div className="banner banner-error" role="alert">
          <span>{actionError}</span>
          <button
            type="button"
            className="banner-close"
            aria-label={t("graph.dismissError")}
            onClick={() => setActionError(null)}
          >
            ×
          </button>
        </div>
      ) : null}

      {hasPages && data ? (
        <div className="graph-chips" aria-label={t("graph.filterByTag")}>
          {(data.tags ?? []).map((tag) => (
            <button
              key={tag}
              type="button"
              className={`graph-chip${selectedTags.includes(tag) ? " is-active" : ""}`}
              aria-pressed={selectedTags.includes(tag)}
              onClick={() => toggleTag(tag)}
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}

      <div className="graph-body">
        {status === "loading" ? (
          <div className="graph-state graph-state-loading" data-testid="graph-loading">
            <p>{t("graph.loading")}</p>
          </div>
        ) : status === "error" ? (
          <div className="empty-state" data-testid="graph-error">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="monitor" size={26} />
            </span>
            <h2>{t("graph.loadFailed")}</h2>
            <p>{error ?? t("errors.generic")}</p>
            <button type="button" className="button-primary" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : !hasPages ? (
          <div className="empty-state" data-testid="graph-empty">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="graph" size={26} />
            </span>
            <h2>{t("graph.empty")}</h2>
            <p>
              {t("graph.emptyHintBefore")}<code>[[</code>{t("graph.emptyHintAfter")}
            </p>
            <button type="button" className="button-primary" onClick={onNewPage}>
              {t("sidebar.newPage")}
            </button>
          </div>
        ) : !hasVisible ? (
          <div className="empty-state" data-testid="graph-filter-empty">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="search" size={26} />
            </span>
            <h2>{t("graph.filterEmpty")}</h2>
            <button type="button" className="button-secondary" onClick={clearFilters}>
              {t("graph.clearFilter")}
            </button>
          </div>
        ) : filtered ? (
          <>
            <GraphCanvas
              nodes={canvasNodes}
              links={canvasLinks}
              highlightId={highlightId}
              testId="graph-canvas"
              ariaLabel={ariaSummary(filtered)}
              showControls
              reducedMotion={reducedMotion}
              onOpenPage={onOpenPage}
              onCreatePage={(title) => {
                const ghost = filtered.ghosts.find(
                  (candidate) => candidate.title.toLowerCase() === title.toLowerCase(),
                );
                if (ghost) createGhost(ghost);
              }}
            />
            <p className="graph-hint">{t("graph.hint")}</p>
          </>
        ) : null}

        {legendOpen && status === "ready" && hasPages ? (
          <aside className="graph-legend" id="graph-legend" data-testid="graph-legend">
            <p className="graph-legend-title">{t("graph.legend")}</p>
            <p className="graph-legend-row">
              <span className="graph-legend-solid" aria-hidden="true" /> {t("graph.legendPage")}
            </p>
            {hasBoards ? (
              <p className="graph-legend-row" data-testid="graph-legend-board">
                <span className="graph-legend-board" aria-hidden="true" /> {t("graph.legendBoard")}
              </p>
            ) : null}
            <p className="graph-legend-row">
              <span className="graph-legend-dashed" aria-hidden="true" /> {t("graph.legendGhost")}
            </p>
            {sampleIcon ? (
              <p className="graph-legend-row" data-testid="graph-legend-icon">
                <span className="graph-legend-emoji" aria-hidden="true">
                  {sampleIcon}
                </span>{" "}
                emoji = page icon
              </p>
            ) : null}
            {(data?.tags ?? []).length > 0 ? (
              <p className="graph-legend-caption">{t("graph.legendColour")}</p>
            ) : null}
            {(data?.tags ?? []).slice(0, 8).map((tag) => (
              <p key={tag} className="graph-legend-row graph-legend-tag">
                <span
                  className="graph-legend-dot"
                  style={{ background: `var(--graph-${paletteIndex(tag)})` }}
                  aria-hidden="true"
                />
                #{tag}
              </p>
            ))}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
