/**
 * The board's export (spec/v0-6 §D): PNG (2×) or SVG, for the whole board or the selection, on the theme background
 * or transparent; "transparent" is remembered for the next export. #pypzxe6i: one dialog, opened by the canvas's export
 * button, the board's row ⋯ and Cmd+K.
 */
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./board-menu.css";
import { useT } from "../i18n/index.js";
import { useModal } from "../lib/modal.js";

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

function ExportIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 4v11" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M5 19h14" />
    </svg>
  );
}

/**
 * #pypzxe6i (@lead): the canvas's own entry point, top right where its ⋯ was: one button that opens the export dialog
 * (the board's row ⋯ and Cmd+K open the same one). While an export runs it shows a spinner.
 */
export function BoardExportButton({ busy, onClick }: { busy: ExportFormat | null; onClick: () => void }) {
  const t = useT();
  return (
    <div
      className="board-menu"
      // The board must not start a selection, create a sticky or run shortcuts from here.
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="board-menu-button"
        aria-label={t("board.export.menuItem")}
        data-tooltip={busy ? t("board.menu.exporting") : t("board.export.menuItem")}
        data-testid="board-export-button"
        aria-busy={busy ? "true" : undefined}
        onClick={onClick}
      >
        {busy ? <span className="board-menu-spinner" aria-hidden="true" /> : <ExportIcon />}
      </button>
    </div>
  );
}

export function BoardExportDialog({ hasSelection, busy, initialFormat = "png", onExport, onClose }: {
  hasSelection: boolean;
  /** An export is running: Export shows it and can't start another. */
  busy: ExportFormat | null;
  initialFormat?: ExportFormat;
  onExport: (request: ExportRequest) => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const modalRef = useRef<HTMLDivElement>(null);
  useModal(modalRef);
  const [format, setFormat] = useState<ExportFormat>(initialFormat);
  // Opened with objects selected, it offers to export just those (checked).
  const [selection, setSelection] = useState(hasSelection);
  const [transparent, setTransparent] = useState(loadTransparent);

  const run = () => {
    if (busy) return;
    onExport({ format, selection: selection && hasSelection, transparent });
    onClose();
  };

  // On the page's body (@opus-editor): the board root is a size container (#3nnx98m4), so a fixed backdrop inside it
  // would cover and fit only the board, not the window. Out of the board root, its keys never reach the board either.
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      // A portal still bubbles React events to its React parents (the board root): pointer and double-click events
      // stop here, so nothing in the dialog starts a selection or a sticky on the board.
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      // The board must not take these keys (Escape is the dialog's).
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="modal board-export-dialog" role="dialog" ref={modalRef} aria-modal="true" aria-labelledby={`${id}-title`} data-testid="board-export-dialog">
        <h2 id={`${id}-title`}>{t("board.export.dialogTitle")}</h2>
        <fieldset className="export-dialog-group">
          <legend>{t("board.export.format")}</legend>
          {(["png", "svg"] as const).map((choice) => (
            <label key={choice} className="export-dialog-choice">
              <input
                type="radio"
                name={`${id}-format`}
                value={choice}
                data-testid={`board-export-format-${choice}`}
                checked={format === choice}
                onChange={() => setFormat(choice)}
              />
              <span>{t(choice === "png" ? "board.export.png" : "board.export.svg")}</span>
            </label>
          ))}
        </fieldset>
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
        <div className="modal-actions">
          <button type="button" className="button-secondary" data-testid="board-export-cancel" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button-primary" data-testid="board-export-confirm" disabled={busy !== null} onClick={run}>
            {busy ? t("board.menu.exporting") : t("board.export.export")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
