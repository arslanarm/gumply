/**
 * "Import from Notion…" (v0.8 B4, spec/notion-import §8, spec/api-import):
 * pick Notion's "Markdown & CSV" export zip and where it goes, follow the
 * import, then read the report and open the new folder. The server does the
 * work (B2): it never touches anything already in the vault.
 */
import { formatImportLimit, NOTION_IMPORT_LIMITS, type NotionImportReport, type PageMeta } from "@gumply/core";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";
import { api, ApiRequestError, type NotionImportJob } from "../api/client.js";
import { useT } from "../i18n/index.js";
import {
  convertedLines,
  folderName,
  IMPORT_ERROR_MESSAGES,
  importErrorKind,
  looksLikeZip,
  NOT_IN_EXPORT,
  progressPercent,
  STEP_MESSAGES,
} from "../lib/notion-import.js";
import { Icon } from "./Icon.js";

/** How often the job is asked about while it runs. */
const POLL_MS = 400;

export interface NotionImportDialogProps {
  /** Where it was opened from: that page or folder is the default target (null: the vault's top level). */
  target: PageMeta | null;
  onClose: () => void;
  /** Open the new folder (and refresh the page list first). */
  onOpenFolder: (id: string) => void;
  /** The vault changed: reload the page list. */
  onImported: () => void;
}

type Phase =
  | { kind: "pick" }
  | { kind: "running"; job: NotionImportJob }
  | { kind: "done"; job: NotionImportJob; report: NotionImportReport }
  | { kind: "error"; message: string; details: string | null };

const sizeText = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function List({ title, items, testId }: { title: string; items: string[]; testId: string }) {
  if (items.length === 0) return null;
  return (
    <details className="notion-import-list" data-testid={testId}>
      <summary>{title}</summary>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </details>
  );
}

export function NotionImportDialog({ target, onClose, onOpenFolder, onImported }: NotionImportDialogProps) {
  const t = useT();
  const id = useId();
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [into, setInto] = useState<string>(target?.id ?? "");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const running = phase.kind === "running";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A running import can't be cancelled (it's all or nothing); the dialog stays until it ends.
      if (event.key === "Escape" && !running) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, running]);

  // Follow the job until it's done or failed.
  const jobId = phase.kind === "running" ? phase.job.id : null;
  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const job = await api.notionImport(jobId);
        if (stopped) return;
        if (job.state === "done" && job.report) {
          setPhase({ kind: "done", job, report: job.report });
          onImported();
          return;
        }
        if (job.state === "failed") {
          // The server's reason (English, e.g. "larger than 2 GB once unpacked") is the detail line.
          setPhase({ kind: "error", message: t(IMPORT_ERROR_MESSAGES.failed), details: job.error ?? null });
          return;
        }
        setPhase({ kind: "running", job });
      } catch (error) {
        if (stopped) return;
        setPhase({ kind: "error", message: t(IMPORT_ERROR_MESSAGES[importErrorKind(error as ApiRequestError)]), details: (error as Error).message ?? null });
        return;
      }
      timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    let timer = window.setTimeout(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [jobId, onImported, t]);

  const choose = (picked: File | null | undefined) => {
    if (!picked) return;
    if (!looksLikeZip(picked)) {
      setFile(null);
      setFileError(t("notionImport.notZip"));
      return;
    }
    setFileError(null);
    setFile(picked);
  };

  const start = async () => {
    if (!file) return;
    try {
      const job = await api.startNotionImport(file, into || null);
      setPhase({ kind: "running", job });
    } catch (error) {
      const kind = importErrorKind(error instanceof ApiRequestError ? error : (error as Error));
      setPhase({
        kind: "error",
        message: t(IMPORT_ERROR_MESSAGES[kind], { limit: formatImportLimit(NOTION_IMPORT_LIMITS.uploadBytes) }),
        details: kind === "running" || kind === "tooLarge" ? null : ((error as Error).message ?? null),
      });
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  };

  let body;
  if (phase.kind === "pick") {
    body = (
      <>
        <p>{t("notionImport.howTo")}</p>
        <button
          type="button"
          className={`notion-import-drop${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`}
          data-testid="notion-import-drop"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <Icon name={file ? "file" : "download"} size={20} />
          <span>{file ? t("notionImport.chosen", { name: file.name, size: sizeText(file.size) }) : t("notionImport.drop")}</span>
          {file ? <span className="notion-import-change">{t("notionImport.change")}</span> : null}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          hidden
          data-testid="notion-import-file"
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        {fileError ? (
          <p className="notion-import-error" role="alert" data-testid="notion-import-file-error">
            {fileError}
          </p>
        ) : null}
        <label className="notion-import-target">
          <span>{t("notionImport.target")}</span>
          <select className="settings-select" data-testid="notion-import-target" value={into} onChange={(event) => setInto(event.target.value)}>
            <option value="">{t("notionImport.targetRoot")}</option>
            {target ? <option value={target.id}>{target.id}</option> : null}
          </select>
        </label>
        <p className="notion-import-note">{t("notionImport.targetHint")}</p>
        <div className="modal-actions">
          <button type="button" className="button-secondary" data-testid="notion-import-cancel" onClick={onClose}>
            {t("notionImport.cancel")}
          </button>
          <button type="button" className="button-primary" data-testid="notion-import-start" disabled={!file} onClick={() => void start()}>
            {t("notionImport.start")}
          </button>
        </div>
      </>
    );
  } else if (phase.kind === "running") {
    const percent = progressPercent(phase.job);
    body = (
      <div className="notion-import-progress" data-testid="notion-import-progress" aria-live="polite">
        <p className="notion-import-step">{t(STEP_MESSAGES[phase.job.state])}</p>
        <div
          className={`notion-import-bar${percent === null ? " is-indeterminate" : ""}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <span style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
        {phase.job.total > 0 ? <p className="notion-import-note">{t("notionImport.progress", { done: phase.job.done, total: phase.job.total })}</p> : null}
      </div>
    );
  } else if (phase.kind === "done") {
    const { report, job } = phase;
    const folder = job.folder ?? "";
    const reimport = /\s\d+$/.test(folderName(folder));
    body = (
      <div className="notion-import-report" data-testid="notion-import-report">
        <p className="notion-import-done">
          <Icon name="checkSquare" size={18} />
          <strong data-testid="notion-import-folder">{t("notionImport.doneTitle", { folder: folderName(folder) })}</strong>
        </p>
        {reimport ? <p className="notion-import-note">{t("notionImport.reimportNote")}</p> : null}
        <ul className="notion-import-counts" data-testid="notion-import-counts">
          <li>{t("notionImport.pages", { count: report.pages })}</li>
          {report.databases > 0 ? (
            <li>
              {t("notionImport.databases", { count: report.databases })} ({t("notionImport.rows", { count: report.rows })})
            </li>
          ) : null}
          {report.attachments > 0 ? <li>{t("notionImport.attachments", { count: report.attachments })}</li> : null}
        </ul>
        {convertedLines(report).length > 0 ? (
          <section>
            <h3>{t("notionImport.convertedTitle")}</h3>
            <ul className="notion-import-converted" data-testid="notion-import-converted">
              {convertedLines(report).map((line) => (
                <li key={line.key}>{t(line.key, { count: line.count })}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <List
          testId="notion-import-skipped"
          title={t("notionImport.skippedTitle", { count: report.skipped.length })}
          items={report.skipped.map((item) => `${item.path}: ${item.reason}`)}
        />
        <List
          testId="notion-import-missing"
          title={t("notionImport.missingTitle", { count: report.missing.length })}
          items={report.missing.map((item) => `${item.link} (${t("notionImport.inPage", { page: item.page })})`)}
        />
        <List
          testId="notion-import-outside"
          title={t("notionImport.outsideTitle", { count: report.outside.length })}
          items={report.outside.map((item) => `${item.url} (${t("notionImport.inPage", { page: item.page })})`)}
        />
        <section className="notion-import-lost" data-testid="notion-import-lost">
          <h3>{t("notionImport.lostTitle")}</h3>
          <p className="notion-import-note">{t("notionImport.lostHint")}</p>
          <ul>
            {NOT_IN_EXPORT.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </section>
        <p className="notion-import-note">{t("notionImport.reportFile")}</p>
        <div className="modal-actions">
          <button type="button" className="button-secondary" data-testid="notion-import-close" onClick={onClose}>
            {t("notionImport.close")}
          </button>
          <button
            type="button"
            className="button-primary"
            data-testid="notion-import-open"
            disabled={!folder}
            onClick={() => {
              onOpenFolder(folder);
              onClose();
            }}
          >
            {t("notionImport.open")}
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="notion-import-failed" data-testid="notion-import-failed">
        <p className="notion-import-error" role="alert" data-testid="notion-import-error">
          {phase.message}
        </p>
        {phase.details ? <p className="notion-import-note">{t("notionImport.details", { error: phase.details })}</p> : null}
        <div className="modal-actions">
          <button type="button" className="button-secondary" onClick={onClose}>
            {t("notionImport.close")}
          </button>
          <button type="button" className="button-primary" data-testid="notion-import-retry" onClick={() => setPhase({ kind: "pick" })}>
            {t("notionImport.tryAgain")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <div className="modal notion-import-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-testid="notion-import">
        <h2 id={`${id}-title`}>{t("notionImport.title")}</h2>
        {body}
      </div>
    </div>
  );
}
