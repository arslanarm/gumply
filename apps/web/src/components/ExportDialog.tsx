import { useEffect, useId, useRef, useState } from "react";
import type { ExportLinks, ExportOptions, ExportTheme, PageSize, PrintMargins, PrintOptions } from "../export/html-export.js";
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

const PDF_KEY = "gumply:export-pdf";

/** Letter where it's the norm (the US and Canada), A4 elsewhere. */
export function defaultPageSize(languages: readonly string[]): PageSize {
  return /^en-(US|CA)$/i.test(languages[0] ?? "") ? "Letter" : "A4";
}

function savedPrint(): PrintOptions {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PDF_KEY) ?? "{}") as Partial<PrintOptions>;
    return {
      pageSize: saved.pageSize === "A4" || saved.pageSize === "Letter" ? saved.pageSize : defaultPageSize(navigator.languages ?? [navigator.language]),
      margins: saved.margins === "narrow" ? "narrow" : "normal",
    };
  } catch {
    return { pageSize: "A4", margins: "normal" };
  }
}

export interface ExportDialogProps {
  title: string;
  /** G1 HTML (theme, links) or G2 PDF (paper size, margins). */
  format?: "html" | "pdf";
  /** Resolves when the file has been built and handed on. */
  onExport: (options: ExportOptions) => Promise<void>;
  onClose: () => void;
}

const SIZES: Array<[PageSize, MessageKey]> = [
  ["A4", "export.pdf.sizeA4"],
  ["Letter", "export.pdf.sizeLetter"],
];
const MARGINS: Array<[PrintMargins, MessageKey]> = [
  ["normal", "export.pdf.marginsNormal"],
  ["narrow", "export.pdf.marginsNarrow"],
];

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
export function ExportDialog({ title, format = "html", onExport, onClose }: ExportDialogProps) {
  const t = useT();
  const id = useId();
  const [options, setOptions] = useState<ExportOptions>(savedOptions);
  const [print, setPrint] = useState<PrintOptions>(savedPrint);
  const pdf = format === "pdf";
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
      if (pdf) window.localStorage.setItem(PDF_KEY, JSON.stringify(print));
      else window.localStorage.setItem(KEY, JSON.stringify(options));
    } catch {
      // Storage disabled: this session only.
    }
    setBusy(true);
    void onExport(pdf ? { theme: "light", links: "text", print } : options).finally(() => setBusy(false));
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
        <h2 id={`${id}-title`}>{t(pdf ? "export.pdf.dialogTitle" : "export.dialogTitle")}</h2>
        <p>
          <strong className="export-dialog-page">{title}</strong> — {t(pdf ? "export.pdf.dialogHint" : "export.dialogHint")}
        </p>
        {pdf ? (
          <>
            {group("export.pdf.size", "size", SIZES, print.pageSize, (pageSize) => setPrint((current) => ({ ...current, pageSize })))}
            {group("export.pdf.margins", "margins", MARGINS, print.margins, (margins) => setPrint((current) => ({ ...current, margins })))}
          </>
        ) : (
          <>
            {group("export.theme", "theme", THEMES, options.theme, (theme) => setOptions((current) => ({ ...current, theme })))}
            {group("export.links", "links", LINKS, options.links, (links) => setOptions((current) => ({ ...current, links })))}
          </>
        )}
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
