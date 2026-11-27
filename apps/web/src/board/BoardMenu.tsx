/**
 * The board's export dialog (spec/v0-6 §D): PNG (2×) or SVG, for the whole board or the selection, on the theme
 * background or transparent; "transparent" is remembered for the next export. #pypzxe6i: it's opened from the
 * board's own ⋯ (its sidebar row, and Cmd+K), as the canvas's own ⋯ menu was a second ⋯ for one board.
 */
import { useId, useRef, useState } from "react";
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

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
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
    </div>
  );
}
