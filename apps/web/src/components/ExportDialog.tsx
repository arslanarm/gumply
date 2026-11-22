import { useEffect, useId, useRef, useState } from "react";
import type { ExportLinks, ExportOptions, ExportTheme } from "../export/html-export.js";
import { useT, type MessageKey } from "../i18n/index.js";

/** The last choices, per device (`gumply:` so the desktop app keeps them). */
const KEY = "gumply:export-html";

function savedOptions(): ExportOptions {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as Partial<ExportOptions>;
    return {
      theme: saved.theme === "dark" || saved.theme === "system" ? saved.theme : "light",
      links: saved.links === "files" ? "files" : "text",
    };
  } catch {
    return { theme: "light", links: "text" };
  }
}

export interface ExportDialogProps {
  title: string;
  /** Resolves when the file has been built and handed to the download. */
  onExport: (options: ExportOptions) => Promise<void>;
  onClose: () => void;
}

const THEMES: Array<[ExportTheme, MessageKey]> = [
  ["light", "export.themeLight"],
  ["dark", "export.themeDark"],
  ["system", "export.themeSystem"],
];
const LINKS: Array<[ExportLinks, MessageKey]> = [
  ["text", "export.linksText"],
  ["files", "export.linksFiles"],
];

/** G1: Export as HTML: theme and link style, then Export. Escape or a click outside cancels. */
export function ExportDialog({ title, onExport, onClose }: ExportDialogProps) {
  const t = useT();
  const id = useId();
  const [options, setOptions] = useState<ExportOptions>(savedOptions);
  const [busy, setBusy] = useState(false);
  const exportRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    exportRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const run = () => {
    if (busy) return;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
      // Storage disabled: this session only.
    }
    setBusy(true);
    void onExport(options).finally(() => setBusy(false));
  };

  const group = <V extends string>(legend: MessageKey, name: string, choices: Array<[V, MessageKey]>, value: V, set: (value: V) => void) => (
    <fieldset className="export-dialog-group">
      <legend>{t(legend)}</legend>
      {choices.map(([choice, label]) => (
        <label key={choice} className="export-dialog-choice">
          <input
            type="radio"
            name={`${id}-${name}`}
            value={choice}
            data-testid={`export-${name}-${choice}`}
            checked={value === choice}
            onChange={() => set(choice)}
          />
          <span>{t(label)}</span>
        </label>
      ))}
    </fieldset>
  );

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="modal export-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="export-dialog">
        <h2 id={`${id}-title`}>{t("export.dialogTitle")}</h2>
        <p>
          <strong className="export-dialog-page">{title}</strong> — {t("export.dialogHint")}
        </p>
        {group("export.theme", "theme", THEMES, options.theme, (theme) => setOptions((current) => ({ ...current, theme })))}
        {group("export.links", "links", LINKS, options.links, (links) => setOptions((current) => ({ ...current, links })))}
        <div className="modal-actions">
          <button type="button" className="button-secondary" data-testid="export-cancel" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="button" className="button-primary" data-testid="export-confirm" onClick={run} disabled={busy} ref={exportRef}>
            {busy ? t("export.exporting") : t("export.export")}
          </button>
        </div>
      </div>
    </div>
  );
}
