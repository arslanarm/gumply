/**
 * Export wiring for the board editor (spec/v0-6 §D). The export code (stage,
 * SVG writer, font) is its own chunk, loaded on the first export.
 */
import type { CanvasBoard } from "@gumply/core";
import { lazy, Suspense, useCallback, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ExportFormat, ExportRequest } from "./BoardMenu.js";
import { frameFollowers } from "./model.js";

const loadExport = () => Promise.all([import("./export/ExportStage.js"), import("./export/download.js")]);
const ExportStage = lazy(() => import("./export/ExportStage.js"));

/** The selected objects, the contents of selected frames, and connectors between them. */
export function exportSubset(board: CanvasBoard, selected: ReadonlySet<string>): CanvasBoard {
  const ids = new Set(selected);
  for (const id of frameFollowers(board, ids)) ids.add(id);
  return {
    ...board,
    nodes: board.nodes.filter((node) => ids.has(node.id)),
    edges: board.edges.filter((edge) => ids.has(edge.fromNode) && ids.has(edge.toNode)),
  };
}

/** The board's name for files: its file name without folders or extension. */
export function boardTitle(boardId: string): string {
  return (boardId.split("/").pop() ?? boardId).replace(/\.canvas$/i, "");
}

interface Job {
  id: number;
  request: ExportRequest;
  board: CanvasBoard;
  background: string | null;
}

export function useBoardExport({ boardId, board, selectedNodeIds, rootRef, onError }: {
  boardId: string;
  board: CanvasBoard;
  selectedNodeIds: readonly string[];
  rootRef: RefObject<HTMLElement | null>;
  onError: (message: string) => void;
}): { busy: ExportFormat | null; start: (request: ExportRequest) => void; preload: () => void; stage: ReactNode } {
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const latest = useRef({ board, selectedNodeIds, boardId, onError });
  latest.current = { board, selectedNodeIds, boardId, onError };
  const nextId = useRef(0);

  const fail = useCallback((error: unknown) => {
    setJob(null);
    setBusy(null);
    const detail = error instanceof Error ? error.message : String(error);
    latest.current.onError(`The board couldn't be exported. ${detail}`);
  }, []);

  const start = useCallback(
    (request: ExportRequest) => {
      if (busy) return;
      const { board: current, selectedNodeIds: selected } = latest.current;
      const subset = request.selection ? exportSubset(current, new Set(selected)) : current;
      if (subset.nodes.length === 0) {
        latest.current.onError("There's nothing on this board to export yet.");
        return;
      }
      const root = rootRef.current;
      const background = request.transparent || !root ? null : getComputedStyle(root).backgroundColor;
      setBusy(request.format);
      void loadExport()
        .then(([stage]) => stage.prepareExport())
        .then(() => {
          nextId.current += 1;
          setJob({ id: nextId.current, request, board: subset, background });
        })
        .catch(fail);
    },
    [busy, fail, rootRef],
  );

  const onDone = useCallback(
    (result: { svg: string; width: number; height: number }) => {
      const current = job;
      setJob(null);
      if (!current) return;
      void (async () => {
        try {
          const [, download] = await loadExport();
          const title = boardTitle(latest.current.boardId);
          const name = download.exportFileName(title, current.request.format, current.request.selection);
          if (current.request.format === "svg") {
            download.downloadBlob(new Blob([result.svg], { type: "image/svg+xml" }), name);
          } else {
            const scale = download.pngScale(result.width, result.height);
            const blob = await download.svgToPng(result.svg, result.width, result.height, scale);
            download.downloadBlob(blob, name);
          }
          setBusy(null);
        } catch (error) {
          fail(error);
        }
      })();
    },
    [fail, job],
  );

  /** Opening the menu starts loading the export code and font. */
  const preload = useCallback(() => {
    void loadExport()
      .then(([stageModule]) => stageModule.prepareExport())
      .catch(() => undefined);
  }, []);

  const stage = job ? (
    <Suspense fallback={null}>
      <ExportStage key={job.id} board={job.board} background={job.background} onDone={onDone} onError={fail} />
    </Suspense>
  ) : null;

  return { busy, start, preload, stage };
}
