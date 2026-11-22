import type { GraphData, GraphNode, PageId } from "@gumply/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiRequestError, fileUrl } from "../api/client.js";
import { GraphCanvas, type CanvasNode } from "./GraphCanvas.js";
import {
  ariaSummary,
  ATTACHMENT_PALETTE_INDEX,
  attachmentPath,
  buildGraphModel,
  filterGraph,
  groupColorer,
  isAttachmentNodeId,
  isTagNodeId,
} from "./graph-model.js";
import { useGraphSettings } from "./graph-settings.js";
import { usePrefersReducedMotion } from "./use-reduced-motion.js";
import { t, useT } from "../i18n/index.js";

export interface LocalGraphPanelProps {
  pageId: PageId;
  onOpenPage: (id: PageId) => void;
  onCreatePage: (title: string) => Promise<void>;
  onClose: () => void;
  /** A tab of the right-hand column (v0.8 D1): the column has the title and the close button. */
  embedded?: boolean;
}

type Status = "loading" | "ready" | "error";
type Depth = 1 | 2;

const DEPTH_KEY = "gumply:local-graph-depth";

function readDepth(): Depth {
  try {
    return sessionStorage.getItem(DEPTH_KEY) === "2" ? 2 : 1;
  } catch {
    return 1;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return t("graph.localLoadFailed");
}

/** Collapsible right-hand graph for the current page (spec/ux §9). */
export function LocalGraphPanel({ pageId, onOpenPage, onCreatePage, onClose, embedded = false }: LocalGraphPanelProps) {
  const t = useT();
  const [depth, setDepth] = useState<Depth>(readDepth);
  const [data, setData] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  // E2: the vault's groups and filters (edited in the global graph's panel).
  // The first layout waits for them, as on the global graph.
  const { settings } = useGraphSettings();
  const filters = settings?.filters;
  const wantAttachments = filters?.showAttachments ?? false;

  const changeDepth = (next: Depth) => {
    setDepth(next);
    try {
      sessionStorage.setItem(DEPTH_KEY, String(next));
    } catch {
      // Session storage is optional.
    }
  };

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const graph = await api.getGraph({ center: pageId, depth, attachments: wantAttachments });
      setData(graph);
      setStatus("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("error");
    }
  }, [pageId, depth, wantAttachments]);

  const settingsReady = settings !== null;
  useEffect(() => {
    if (settingsReady) void load();
  }, [load, settingsReady]);

  const model = useMemo(() => (data ? buildGraphModel(data) : null), [data]);
  // The search box and Orphans are about the whole vault: here only tags,
  // attachments and "existing files only" apply, so the page itself always stays.
  const filtered = useMemo(
    () =>
      model && filters
        ? filterGraph(model, {
            hideUnresolved: filters.hideUnresolved,
            showTags: filters.showTags,
            attachments: filters.showAttachments ? data?.attachments : undefined,
          })
        : null,
    [model, filters, data],
  );
  const canvasNodes = useMemo<CanvasNode[]>(
    () => (filtered ? [...filtered.nodes, ...filtered.ghosts, ...filtered.extras] : []),
    [filtered],
  );
  const canvasLinks = useMemo(() => filtered?.links ?? [], [filtered]);
  const groups = settings?.groups;
  const colorOf = useMemo(() => {
    const group = groupColorer(groups ?? []);
    return (node: GraphNode, palette: readonly string[]) =>
      group(node) ?? (isAttachmentNodeId(node.id) ? (palette[ATTACHMENT_PALETTE_INDEX] ?? null) : null);
  }, [groups]);
  /** Tag nodes have no page to open; attachment nodes open the file. */
  const openNode = (id: PageId) => {
    if (isTagNodeId(id)) return;
    if (isAttachmentNodeId(id)) {
      window.open(fileUrl(attachmentPath(id)), "_blank", "noopener");
      return;
    }
    onOpenPage(id);
  };
  const empty =
    status === "ready" &&
    data !== null &&
    data.nodes.length <= 1 &&
    data.unresolved.length === 0;

  return (
    <aside className={`local-graph${embedded ? " is-embedded" : ""}`} data-testid="local-graph" aria-label={t("graph.localTitle")}>
      <header className="local-graph-header">
        {embedded ? null : <h2>{t("graph.localTitle")}</h2>}
        <div className="local-graph-actions">
          <div className="local-graph-depth" role="group" aria-label={t("graph.linkDepth")}>
            <button
              type="button"
              className={`graph-chip${depth === 1 ? " is-active" : ""}`}
              data-testid="local-depth-1"
              aria-pressed={depth === 1}
              onClick={() => changeDepth(1)}
            >
              1
            </button>
            <button
              type="button"
              className={`graph-chip${depth === 2 ? " is-active" : ""}`}
              data-testid="local-depth-2"
              aria-pressed={depth === 2}
              onClick={() => changeDepth(2)}
            >
              2
            </button>
          </div>
          {embedded ? null : (
          <button
            type="button"
            className="icon-button"
            data-testid="local-graph-close"
            aria-label={t("graph.closeLocal")}
            data-tooltip={t("graph.closeLocal")}
            onClick={onClose}
          >
            ×
          </button>
          )}
        </div>
      </header>

      <div className="local-graph-body">
        {status === "loading" || !settingsReady ? (
          <p className="graph-panel-note">{t("graph.localLoading")}</p>
        ) : status === "error" ? (
          <div className="graph-panel-state">
            <p>{error ?? t("graph.localLoadFailed")}</p>
            <button type="button" className="button-secondary" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          </div>
        ) : empty || !model || !data || !filtered ? (
          <div className="graph-panel-state" data-testid="local-graph-empty">
            <h3>{t("graph.noLinks")}</h3>
            <p>
              {t("graph.noLinksBefore")}<code>[[</code>{t("graph.noLinksAfter")}
            </p>
          </div>
        ) : (
          <GraphCanvas
            nodes={canvasNodes}
            links={canvasLinks}
            highlightId={pageId}
            centerId={pageId}
            testId="local-graph-canvas"
            ariaLabel={ariaSummary(filtered)}
            reducedMotion={reducedMotion}
            onOpenPage={openNode}
            colorOf={colorOf}
            onCreatePage={(title) => {
              const ghost = filtered.ghosts.find(
                (candidate) => candidate.title.toLowerCase() === title.toLowerCase(),
              );
              if (ghost) void onCreatePage(ghost.title);
            }}
          />
        )}
      </div>
    </aside>
  );
}
