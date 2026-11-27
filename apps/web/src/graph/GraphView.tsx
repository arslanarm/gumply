import type { GraphData, GraphNode, GraphSettings, PageId } from "@gumply/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiRequestError, fileUrl, isVaultIndexing } from "../api/client.js";
import { Icon } from "../components/Icon.js";
import { GraphCanvas, type CanvasNode } from "./GraphCanvas.js";
import { GraphControls } from "./GraphControls.js";
import { GraphList, useGraphListMode, useVaultFlag } from "./GraphList.js";
import {
  ariaSummary,
  ATTACHMENT_PALETTE_INDEX,
  attachmentPath,
  FALLBACK_GRAPH_PALETTE,
  buildGraphModel,
  filterGraph,
  graphSubtitle,
  groupColorer,
  isAttachmentNodeId,
  isTagNodeId,
  colouringTags,
  queryHasTag,
  toggleQueryTag,
  tagSlot,
  type GhostNode,
} from "./graph-model.js";
import { useGraphSettings } from "./graph-settings.js";
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
  /** #cp7xvwjc: the vault's tag colours (from the page list), the same in every graph. */
  tagSlots?: ReadonlyMap<string, number>;
}

type Status = "loading" | "ready" | "error";

/** #yy347xgi (2): below this graph width the legend starts closed. */
const LEGEND_MIN_WIDTH = 900;
const LEGEND_KEY = "gumply:graph-legend";


function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error && /fetch|network|load failed/i.test(error.message)) {
    return t("graph.serverDown");
  }
  return t("graph.loadFailed");
}

/** Global graph view at `#graph` (spec/ux §9, D16). */
export function GraphView({ highlightId, onOpenPage, onCreatePage, onNewPage, tagSlots }: GraphViewProps) {
  const t = useT();
  const [data, setData] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // #yy347xgi (2): the legend is open on a wide graph and closed on a narrow one (under 900 px it covers too much),
  // until the user chooses; then their choice is kept (this browser).
  const [legendChoice, setLegendChoice] = useState<boolean | null>(() => {
    try {
      const stored = window.localStorage.getItem(LEGEND_KEY);
      return stored === null ? null : stored === "1";
    } catch {
      return null;
    }
  });
  // Only whether it's wide is kept, so a window drag re-renders only when it crosses the line (@opus-editor).
  const [wide, setWide] = useState<boolean | null>(null);
  const bodyObserver = useRef<ResizeObserver | null>(null);
  const bodyRef = useCallback((element: HTMLDivElement | null) => {
    bodyObserver.current?.disconnect();
    bodyObserver.current = null;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => setWide(element.clientWidth >= LEGEND_MIN_WIDTH);
    measure();
    bodyObserver.current = new ResizeObserver(measure);
    bodyObserver.current.observe(element);
  }, []);
  const legendOpen = legendChoice ?? wide ?? true;
  const setLegendOpen = (next: boolean) => {
    setLegendChoice(next);
    try {
      window.localStorage.setItem(LEGEND_KEY, next ? "1" : "0");
    } catch {
      // Private mode: the choice lasts for this visit.
    }
  };
  const [controlsOpen, setControlsOpen] = useState(false);
  const [listMode, setListMode, listModeReady] = useGraphListMode("global");
  // #yy347xgi (4): a search dims the rest instead of hiding it (opt-in; isolate stays the default, @lead).
  const [showRest, setShowRest] = useVaultFlag("graph-show-rest");
  const [fitRequest, setFitRequest] = useState<{ ids: ReadonlySet<string>; n: number } | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // E1: groups and filters, per vault. The graph waits for them, so its first
  // layout already uses them (no restart when they arrive).
  const { settings, update: updateSettings } = useGraphSettings();
  // The search box stays per visit, as before E1: a filter typed once must not
  // greet the next visit with a half-empty graph. (`filters.search` is kept in
  // the file as read, for Obsidian round-trips.)
  const [query, setQuery] = useState("");
  const wantAttachments = settings?.filters.showAttachments ?? false;

  const load = useCallback(async (attachments: boolean) => {
    setStatus("loading");
    setError(null);
    try {
      const graph = await api.getGraph({ attachments });
      setData(graph);
      setStatus("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("error");
    }
  }, []);

  const settingsReady = settings !== null;
  useEffect(() => {
    if (settingsReady) void load(wantAttachments);
    // Attachments turned on later: fetch them once; turning them off just hides them.
  }, [settingsReady, load]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (wantAttachments && data && !data.attachments) {
      api
        .getGraph({ attachments: true })
        .then(setData)
        .catch((caught: unknown) => setActionError(errorMessage(caught)));
    }
  }, [wantAttachments, data]);

  const model = useMemo(() => (data ? buildGraphModel(data) : null), [data]);
  const filters = settings?.filters;
  const filtered = useMemo(
    () =>
      model && filters
        ? filterGraph(model, {
            query,
            hideUnresolved: filters.hideUnresolved,
            showOrphans: filters.showOrphans,
            showTags: filters.showTags,
            attachments: filters.showAttachments ? data?.attachments : undefined,
          })
        : null,
    [model, filters, query, data],
  );

  // #yy347xgi (4): with "Show the rest" and a search, the canvas draws the graph without the search and the
  // matches are its spotlight (everything else dimmed); the subtitle and the list still describe the matches.
  const inContext = showRest && query.trim().length > 0;
  const unsearched = useMemo(
    () =>
      inContext && model && filters
        ? filterGraph(model, {
            hideUnresolved: filters.hideUnresolved,
            showOrphans: filters.showOrphans,
            showTags: filters.showTags,
            attachments: filters.showAttachments ? data?.attachments : undefined,
          })
        : null,
    [inContext, model, filters, data],
  );
  const drawn = unsearched ?? filtered;
  const spotlight = useMemo<ReadonlySet<string> | null>(
    () => (inContext && filtered ? new Set([...filtered.nodes, ...filtered.ghosts, ...filtered.extras].map((node) => node.id)) : null),
    [inContext, filtered],
  );

  // Stable arrays: a new identity on every render would restart the force
  // simulation (and the auto-fit) on unrelated state changes such as hovering.
  const canvasNodes = useMemo<CanvasNode[]>(
    () => (drawn ? [...drawn.nodes, ...drawn.ghosts, ...drawn.extras] : []),
    [drawn],
  );
  const canvasLinks = useMemo(() => drawn?.links ?? [], [drawn]);

  // E1: the first matching group colours a node; attachments otherwise share one theme colour.
  const groups = settings?.groups;
  const colorOf = useMemo(() => {
    const group = groupColorer(groups ?? []);
    return (node: GraphNode, palette: readonly string[]) =>
      group(node) ??
      (isAttachmentNodeId(node.id) ? (palette[ATTACHMENT_PALETTE_INDEX] ?? null) : null) ??
      (node.tags[0] ? (palette[tagSlot(node.tags[0], tagSlots)] ?? null) : null);
  }, [groups, tagSlots]);
  const legendGroups = useMemo(() => (groups ?? []).filter((group) => group.query.trim().length > 0), [groups]);
  // #cp7xvwjc: the tags that colour nodes here (not those a group or the attachment colour overrides),
  // most nodes first, from the unfiltered model so a search never changes the rows.
  const legendTags = useMemo(() => {
    if (!model) return [];
    const group = groupColorer(groups ?? []);
    return colouringTags(model.nodes.filter((node) => !isAttachmentNodeId(node.id) && !group(node))).slice(0, 8);
  }, [model, groups]);

  // #yy347xgi (6): the palette colours the tags here already use, so a new group doesn't repeat one.
  const tagColors = useMemo(() => legendTags.map((tag) => FALLBACK_GRAPH_PALETTE[tagSlot(tag, tagSlots)]!).filter(Boolean), [legendTags, tagSlots]);

  /** Tag nodes search for their tag; attachment nodes open the file. */
  const openNode = (id: string) => {
    if (isTagNodeId(id)) {
      const node = (drawn ?? filtered)?.extras.find((candidate) => candidate.id === id);
      if (node) setQuery(`tag:${node.title}`);
      return;
    }
    if (isAttachmentNodeId(id)) {
      window.open(fileUrl(attachmentPath(id)), "_blank", "noopener");
      return;
    }
    onOpenPage(id);
  };

  // #yy347xgi (3): a chip is its `tag:#x` term in the search (shown there, editable, cleared with it).
  const toggleTag = (tag: string) => setQuery((current) => toggleQueryTag(current, tag));

  const clearFilters = () => setQuery("");

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
  const hasVisible = (filtered?.nodes.length ?? 0) + (filtered?.ghosts.length ?? 0) + (filtered?.extras.length ?? 0) > 0;
  const filtersActive = query.trim().length > 0;

  return (
    <section className="graph-view" aria-label={t("graph.title")}>
      <header className="graph-header">
        <div>
          <h2>{t("graph.title")}</h2>
          <p className="graph-subtitle" data-testid="graph-subtitle">
            {/* #yy347xgi (15): each part stays whole on a narrow window ("8 not created yet" never splits). */}
            {hasPages && data && filtered
              ? graphSubtitle(filtered)
                  .split(" · ")
                  .map((part, index) => (
                    <span key={index} className="graph-subtitle-part">
                      {index > 0 ? " · " : ""}
                      {part}
                    </span>
                  ))
              : t("graph.subtitle")}
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
                    } else if (event.key === "Enter" && spotlight && spotlight.size > 0) {
                      // #yy347xgi (4): Enter fits the view to the matches (shown in context).
                      event.preventDefault();
                      setFitRequest((current) => ({ ids: spotlight, n: (current?.n ?? 0) + 1 }));
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
              {query.trim() && !listMode ? (
                // #yy347xgi (4): show the search in context: matches bright, the rest dimmed, not hidden.
                <button
                  type="button"
                  className={`button-secondary graph-show-rest${showRest ? " is-active" : ""}`}
                  data-testid="graph-show-rest"
                  aria-pressed={showRest}
                  onClick={() => setShowRest(!showRest)}
                >
                  {t("graph.showRest")}
                </button>
              ) : null}
              <button
                type="button"
                className={`button-secondary graph-panel-toggle${controlsOpen ? " is-active" : ""}`}
                data-testid="graph-panel-toggle"
                aria-expanded={controlsOpen}
                aria-label={t("graph.panel.open")}
                data-tooltip={t("graph.panel.open")}
                disabled={!settings}
                onClick={() => setControlsOpen((value) => !value)}
              >
                <Icon name="filter" size={14} />
              </button>
              {/* #62tnekds: the graph as a list of links, for the keyboard and screen readers. */}
              <button
                type="button"
                className={`button-secondary graph-list-toggle${listMode ? " is-active" : ""}`}
                data-testid="graph-list-toggle"
                aria-pressed={listMode}
                onClick={() => setListMode(!listMode)}
              >
                {t("graph.list.toggle")}
              </button>
              {listMode ? null : (
              <button
                type="button"
                className={`button-secondary graph-legend-toggle${legendOpen ? " is-active" : ""}`}
                aria-expanded={legendOpen}
                aria-controls="graph-legend"
                onClick={() => setLegendOpen(!legendOpen)}
              >
                {t("graph.legend")}
              </button>
              )}
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
              className={`graph-chip${queryHasTag(query, tag) ? " is-active" : ""}`}
              aria-pressed={queryHasTag(query, tag)}
              onClick={() => toggleTag(tag)}
            >
              #{tag}
            </button>
          ))}
        </div>
      ) : null}

      <div className="graph-body" ref={bodyRef}>
        {status === "loading" || !settings || !listModeReady ? (
          <div className="graph-state graph-state-loading" data-testid="graph-loading">
            {/* #g95wkd9y: a vault just opened is still indexing its links; the graph waits for them. */}
            <p>{isVaultIndexing() ? t("graph.indexing") : t("graph.loading")}</p>
          </div>
        ) : status === "error" ? (
          <div className="empty-state" data-testid="graph-error">
            <span className="empty-state-icon" aria-hidden="true">
              <Icon name="monitor" size={26} />
            </span>
            <h2>{t("graph.loadFailed")}</h2>
            <p>{error ?? t("errors.generic")}</p>
            <button type="button" className="button-primary" onClick={() => void load(wantAttachments)}>
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
        ) : filtered && listMode ? (
          <GraphList
            nodes={filtered.nodes}
            ghosts={filtered.ghosts}
            label={t("graph.list.label")}
            testId="graph-list"
            onOpenPage={openNode}
            onCreateGhost={createGhost}
          />
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
              onOpenPage={openNode}
              colorOf={colorOf}
              forces={settings?.forces}
              spotlight={spotlight}
              fitRequest={fitRequest}
              onCreatePage={(title) => {
                const ghost = (drawn ?? filtered).ghosts.find(
                  (candidate) => candidate.title.toLowerCase() === title.toLowerCase(),
                );
                if (ghost) createGhost(ghost);
              }}
            />
            <p className="graph-hint">{t("graph.hint")}</p>
          </>
        ) : null}

        {controlsOpen && settings && status === "ready" && hasPages ? (
          <GraphControls settings={settings} listMode={listMode} usedColors={tagColors} onChange={(next: GraphSettings) => updateSettings(next)} onClose={() => setControlsOpen(false)} />
        ) : null}

        {legendOpen && !listMode && status === "ready" && hasPages ? (
          <aside className="graph-legend" id="graph-legend" data-testid="graph-legend">
            <p className="graph-legend-title">{t("graph.legend")}</p>
            {legendGroups.map((group, index) => (
              <p key={`${index}-${group.query}`} className="graph-legend-row graph-legend-group" data-testid="graph-legend-group">
                <span className="graph-legend-dot" style={{ background: group.color }} aria-hidden="true" />
                <span className="graph-legend-query">{group.query}</span>
              </p>
            ))}
            <p className="graph-legend-row">
              <span className="graph-legend-solid" aria-hidden="true" /> {t("graph.legendPage")}
            </p>
            {hasBoards ? (
              <p className="graph-legend-row" data-testid="graph-legend-board">
                <span className="graph-legend-board" aria-hidden="true" /> {t("graph.legendBoard")}
              </p>
            ) : null}
            {settings?.filters.hideUnresolved ? null : (
              <p className="graph-legend-row">
                <span className="graph-legend-dashed" aria-hidden="true" /> {t("graph.legendGhost")}
              </p>
            )}
            {settings?.filters.showAttachments ? (
              <p className="graph-legend-row" data-testid="graph-legend-attachment">
                <span className="graph-legend-dot" style={{ background: `var(--graph-${ATTACHMENT_PALETTE_INDEX})` }} aria-hidden="true" />{" "}
                {t("graph.legendAttachment")}
              </p>
            ) : null}
            {sampleIcon ? (
              <p className="graph-legend-row" data-testid="graph-legend-icon">
                <span className="graph-legend-emoji" aria-hidden="true">
                  {sampleIcon}
                </span>{" "}
                {t("graph.legendIcon")}
              </p>
            ) : null}
            {/* #yy347xgi (12): the ring around the page you came from. */}
            {highlightId && drawn?.nodes.some((node) => node.id === highlightId) ? (
              <p className="graph-legend-row" data-testid="graph-legend-current">
                <span className="graph-legend-ring" aria-hidden="true" /> {t("graph.legendCurrent")}
              </p>
            ) : null}
            {/* #yy347xgi (5): with the Tags filter on, tag nodes (drawn with a ring of their colour). */}
            {settings?.filters.showTags && drawn?.extras.some((node) => isTagNodeId(node.id)) ? (
              <p className="graph-legend-row" data-testid="graph-legend-tag-node">
                <span className="graph-legend-tag-node" aria-hidden="true" /> {t("graph.legendTagNode")}
              </p>
            ) : null}
            {legendTags.length > 0 ? (
              <p className="graph-legend-caption">{t("graph.legendColour")}</p>
            ) : null}
            {/* #cp7xvwjc: the tags that colour nodes, most nodes first, in the colour drawn. */}
            {legendTags.map((tag) => (
              <p key={tag} className="graph-legend-row graph-legend-tag" data-testid="graph-legend-tag" data-tag={tag}>
                <span
                  className="graph-legend-dot"
                  style={{ background: `var(--graph-${tagSlot(tag, tagSlots)})` }}
                  aria-hidden="true"
                />
                #{tag}
              </p>
            ))}
            {/* #yy347xgi (11): grey is a page with no tag (or one no group colours). */}
            {legendTags.length > 0 ? (
              <p className="graph-legend-row" data-testid="graph-legend-no-tag">
                <span className="graph-legend-solid" aria-hidden="true" /> {t("graph.legendNoTag")}
              </p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
