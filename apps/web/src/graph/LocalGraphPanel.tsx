import type { GraphData, PageId } from "@gumply/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiRequestError } from "../api/client.js";
import { GraphCanvas, type CanvasNode } from "./GraphCanvas.js";
import { ariaSummary, buildGraphModel } from "./graph-model.js";
import { usePrefersReducedMotion } from "./use-reduced-motion.js";

export interface LocalGraphPanelProps {
  pageId: PageId;
  onOpenPage: (id: PageId) => void;
  onCreatePage: (title: string) => Promise<void>;
  onClose: () => void;
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
  return "Could not load the local graph.";
}

/** Collapsible right-hand graph for the current page (spec/ux §9). */
export function LocalGraphPanel({ pageId, onOpenPage, onCreatePage, onClose }: LocalGraphPanelProps) {
  const [depth, setDepth] = useState<Depth>(readDepth);
  const [data, setData] = useState<GraphData | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

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
      const graph = await api.getGraph({ center: pageId, depth });
      setData(graph);
      setStatus("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setStatus("error");
    }
  }, [pageId, depth]);

  useEffect(() => {
    void load();
  }, [load]);

  const model = useMemo(() => (data ? buildGraphModel(data) : null), [data]);
  const canvasNodes = useMemo<CanvasNode[]>(
    () => (model ? [...model.nodes, ...model.ghosts] : []),
    [model],
  );
  const canvasLinks = useMemo(() => model?.links ?? [], [model]);
  const empty =
    status === "ready" &&
    data !== null &&
    data.nodes.length <= 1 &&
    data.unresolved.length === 0;

  return (
    <aside className="local-graph" data-testid="local-graph" aria-label="Local graph">
      <header className="local-graph-header">
        <h2>Local graph</h2>
        <div className="local-graph-actions">
          <div className="local-graph-depth" role="group" aria-label="Link depth">
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
          <button
            type="button"
            className="icon-button"
            data-testid="local-graph-close"
            aria-label="Close local graph"
            data-tooltip="Close local graph"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      <div className="local-graph-body">
        {status === "loading" ? (
          <p className="graph-panel-note">Loading…</p>
        ) : status === "error" ? (
          <div className="graph-panel-state">
            <p>{error ?? "Could not load the local graph."}</p>
            <button type="button" className="button-secondary" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : empty || !model || !data ? (
          <div className="graph-panel-state" data-testid="local-graph-empty">
            <h3>No links yet.</h3>
            <p>
              Type <code>[[</code> in this page to connect it.
            </p>
          </div>
        ) : (
          <GraphCanvas
            nodes={canvasNodes}
            links={canvasLinks}
            highlightId={pageId}
            centerId={pageId}
            testId="local-graph-canvas"
            ariaLabel={ariaSummary(model)}
            reducedMotion={reducedMotion}
            onOpenPage={onOpenPage}
            onCreatePage={(title) => {
              const ghost = model.ghosts.find(
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
