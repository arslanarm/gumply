/**
 * The board's ⋯ menu (spec/v0-6 §D): Export as PNG (2×) or SVG, for the
 * whole board or the selection, on the theme background or transparent.
 * The two options are remembered for the next export.
 */
import { useEffect, useRef, useState } from "react";
import "./board-menu.css";
import { useT } from "../i18n/index.js";

export type ExportFormat = "png" | "svg";

export interface ExportRequest {
  format: ExportFormat;
  /** Only the selected objects (and connectors between them). */
  selection: boolean;
  transparent: boolean;
}

const OPTIONS_KEY = "gumply:board-export";

function loadTransparent(): boolean {
  try {
    return (JSON.parse(window.localStorage.getItem(OPTIONS_KEY) ?? "{}") as { transparent?: unknown }).transparent === true;
  } catch {
    return false;
  }
}

function saveTransparent(transparent: boolean): void {
  try {
    window.localStorage.setItem(OPTIONS_KEY, JSON.stringify({ transparent }));
  } catch {
    // Not remembered; the export still works.
  }
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19h14" />
    </svg>
  );
}

export function BoardMenu({ hasSelection, busy, onExport, onOpen }: {
  hasSelection: boolean;
  /** An export is running: its items show progress and can't start another. */
  busy: ExportFormat | null;
  onExport: (request: ExportRequest) => void;
  /** The menu opened (the host can start loading the export code). */
  onOpen?: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState(hasSelection);
  const [transparent, setTransparent] = useState(loadTransparent);
  const ref = useRef<HTMLDivElement>(null);

  // Opening the menu with objects selected offers to export just those.
  useEffect(() => {
    if (open) setSelection(hasSelection);
  }, [open, hasSelection]);

  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  useEffect(() => {
    if (open) onOpenRef.current?.();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  const run = (format: ExportFormat) => {
    if (busy) return;
    onExport({ format, selection: selection && hasSelection, transparent });
    setOpen(false);
  };

  return (
    <div
      className="board-menu"
      ref={ref}
      // The board must not start a selection, create a sticky or run shortcuts from here.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={`board-menu-button${open ? " is-open" : ""}`}
        aria-label={t("board.menu.label")}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={busy ? t("board.menu.exporting") : t("board.menu.more")}
        data-testid="board-menu-button"
        aria-busy={busy ? "true" : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {busy ? <span className="board-menu-spinner" aria-hidden="true" /> : <MoreIcon />}
      </button>
      {open ? (
        <div className="board-menu-list" role="menu" aria-label={t("board.menu.menuLabel")} data-testid="board-menu">
          <button type="button" role="menuitem" className="board-menu-item" data-testid="board-export-png" disabled={busy !== null} onClick={() => run("png")}>
            <ExportIcon />
            <span>{t("board.menu.exportPng")}</span>
          </button>
          <button type="button" role="menuitem" className="board-menu-item" data-testid="board-export-svg" disabled={busy !== null} onClick={() => run("svg")}>
            <ExportIcon />
            <span>{t("board.menu.exportSvg")}</span>
          </button>
          <div className="board-menu-separator" role="separator" />
          <label className={`board-menu-check${hasSelection ? "" : " is-disabled"}`}>
            <input
              type="checkbox"
              checked={selection && hasSelection}
              disabled={!hasSelection}
              data-testid="board-export-selection"
              onChange={(event) => setSelection(event.target.checked)}
            />
            <span>{t("board.menu.selectionOnly")}</span>
          </label>
          <label className="board-menu-check">
            <input
              type="checkbox"
              checked={transparent}
              data-testid="board-export-transparent"
              onChange={(event) => {
                setTransparent(event.target.checked);
                saveTransparent(event.target.checked);
              }}
            />
            <span>{t("board.menu.transparent")}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}
