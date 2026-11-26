/**
 * A database view (D34, spec/api-bases, #sg36ng2d): the tabs of a `.base`
 * file's views, the toolbar, and the open view's layout.
 *
 * The server runs the view (`GET /bases/:id/view`); this component only
 * shows it and turns edits into a new config (`PUT /bases/:id`, which writes
 * only what changed) or a page's properties (`PUT /pages/:id`, v1.12).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaseColumn, BaseConfig, BaseRow, BaseValue, BaseView as BaseViewConfig, BaseViewResult, PageId, PageMeta, PropertyType } from "@gumply/core";
import { nextOptionColor, ownedRowsFolder, selectedValues, selectSettings, withSelectSettings, type SelectKind, type SelectOption } from "@gumply/core";
import { api, ApiRequestError, type BaseDocument } from "../api/client.js";
import { Icon, type IconName } from "../components/Icon.js";
import { t as translate, useT, type MessageKey } from "../i18n/index.js";
import { Popover } from "./Popover.js";
import { TableView, ROW_HEIGHT } from "./TableView.js";
import { ViewToolbar, type Panel } from "./ViewToolbar.js";
import { CardsView, KanbanView, ListView } from "./layouts.js";
import { CalendarView } from "./CalendarView.js";
import { baseSource, viewClauses } from "./rules.js";
import { BaseLinks } from "./values.js";
import { BaseSaver, pendingSaverFor } from "./base-saver.js";
import { parseCsv, type PastedRow } from "./paste.js";
import type { PreviewResult } from "./PastePreview.js";
import { registerSaver } from "../lib/pending-saves.js";
import type { SaveState } from "../editor/autosave.js";
import "./bases.css";

const LAYOUTS = ["table", "kanban", "list", "cards", "calendar"] as const;
type Layout = (typeof LAYOUTS)[number];
/** Layouts this version draws; the others are kept in the file and listed. */
const DRAWN: readonly string[] = ["table", "kanban", "list", "cards", "calendar"];

const LAYOUT_ICONS: Record<Layout, IconName> = {
  table: "table",
  kanban: "kanban",
  list: "list",
  cards: "cards",
  calendar: "calendar",
};

function layoutIcon(type: string): IconName {
  return (LAYOUT_ICONS as Record<string, IconName>)[type] ?? "database";
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface BaseViewProps {
  baseId: PageId;
  initial: BaseDocument;
  pages: readonly PageMeta[];
  onOpen: (id: PageId) => void;
  /** The base file was saved (new `updated`, maybe a new id after a rename). */
  onSaved?: (meta: PageMeta) => void;
  /** Something failed that the user should see. */
  onError?: (message: string) => void;
  /** Changes when pages in the vault changed (the app's page poll). */
  refreshKey?: string;
  /** Embedded in a page (`![[X.base#View]]`). */
  embed?: { thisId: PageId; viewName?: string; maxRows?: number };
  /**
   * #ups4ikpj (D22): the full-page view reports its saves to the app's save bar and hands it the
   * conflict choice (Keep mine / Reload). Without these (an embed), a conflict reloads as before.
   */
  onSaveState?: (state: SaveState) => void;
  onReady?: (controls: BaseViewControls) => void;
  /** Keep mine kept the other version here (`.gumply/conflicts/…`). */
  onConflictBackup?: (path: string) => void;
}

/** What the app's save bar needs from an open view. */
export interface BaseViewControls {
  flush: () => Promise<void>;
  isDirty: () => boolean;
  keepMine: () => Promise<void>;
}

export function BaseView(props: BaseViewProps) {
  const t = useT();
  // #vc4hivrr: `[[links]]` in values open pages.
  const baseLinks = useMemo(() => ({ pages: props.pages, onOpen: props.onOpen }), [props.pages, props.onOpen]);
  const { baseId, embed } = props;
  const [doc, setDoc] = useState<BaseDocument>(props.initial);
  const docRef = useRef(doc);
  docRef.current = doc;
  const config = doc.config;
  const views = config.views;
  const [activeName, setActiveName] = useState<string | null>(() => embed?.viewName ?? views[0]?.name ?? null);
  const active = views.find((view) => view.name === activeName) ?? views[0] ?? null;
  const [result, setResult] = useState<BaseViewResult | null>(null);
  const resultRef = useRef(result);
  /** #7prbquxu phase 2: "Import CSV…": the chosen file's rows, for the table's paste preview. */
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const [importBlock, setImportBlock] = useState<{ rows: string[][]; n: number } | null>(null);
  resultRef.current = result;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renameRowId, setRenameRowId] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<{ panel: Panel; n: number } | null>(null);
  const writer = useMemo(() => `base-${Math.random().toString(36).slice(2, 10)}`, []);
  // #hrdgchfb: an embed has no save bar, so it asks in place (Keep mine / Reload) and notes the backup.
  const [inlineConflict, setInlineConflict] = useState(false);
  const [inlineNote, setInlineNote] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const conflictRef = useRef<HTMLDivElement | null>(null);
  const focusInlineChoice = useRef(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    saverRef.current?.setVersion(props.initial.meta.updated);
    setDoc(props.initial);
  }, [props.initial]);

  // The file changed outside this view (Obsidian, another tab, the disk):
  // the vault's page list shows a newer `updated` for it, so read it again.
  // Our own saves already set `doc.meta.updated` to the saved version.
  const listedUpdated = props.pages.find((page) => page.id === baseId)?.updated;
  useEffect(() => {
    if (!listedUpdated || listedUpdated <= docRef.current.meta.updated) return;
    // #ups4ikpj: a change of the user's is on its way or held by a conflict: don't replace it.
    if (saverRef.current?.isDirty()) return;
    let cancelled = false;
    api
      .getBase(baseId)
      .then((loaded) => {
        if (cancelled || loaded.meta.updated <= docRef.current.meta.updated || saverRef.current?.isDirty()) return;
        saverRef.current?.setVersion(loaded.meta.updated);
        setDoc(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [baseId, listedUpdated]);

  const load = useCallback(async () => {
    if (!active || doc.error) return;
    const seq = ++requestSeq.current;
    try {
      const next = await api.runBaseView(baseId, { name: active.name, thisId: embed?.thisId ?? null });
      if (seq !== requestSeq.current) return;
      setResult(next);
      setLoadError(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setLoadError(errorText(error));
    }
  }, [baseId, active, doc.error, embed?.thisId]);

  // Run the view when it (or its config) changes…
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId, active?.name, doc.meta.updated, doc.error]);

  // …and again, debounced, when pages in the vault changed. Through a ref:
  // the timer must run the view open when it fires, not the one open when
  // the pages changed (a tab switch in between would show the old view).
  const loadRef = useRef(load);
  loadRef.current = load;
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    const timer = window.setTimeout(() => void loadRef.current(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  const propsRef = useRef(props);
  propsRef.current = props;
  // The view stays mounted across a rename (App keys it by session), so the saver, made once, must
  // always save to the current id, never the one it was made with.
  const baseIdRef = useRef(baseId);
  baseIdRef.current = baseId;

  /** Show the file as it is now (after a failed save, or a conflict without the app's save bar). */
  const reloadFromDisk = useCallback(async (fallback: BaseDocument) => {
    try {
      const loaded = await api.getBase(baseIdRef.current);
      saverRef.current?.setVersion(loaded.meta.updated);
      setDoc(loaded);
    } catch {
      setDoc(fallback);
    }
  }, []);

  // #ups4ikpj: saves go one at a time; a 409 keeps the user's change for the save bar's choice.
  const saverRef = useRef<BaseSaver | null>(null);
  if (saverRef.current === null) {
    saverRef.current = new BaseSaver(props.initial.meta.updated, {
      send: (config, { expectedUpdated, force }) =>
        api.saveBase(baseIdRef.current, { config, expectedUpdated, writer, ...(force ? { force: true } : {}) }),
      // The server lets this view's own exit save through while its previous write is still the newest.
      sendOnExit: (config, { expectedUpdated }) => api.saveBaseOnExit(baseIdRef.current, { config, expectedUpdated, writer }),
      onSaved: (saved, pending) => {
        // A newer change is still on its way: keep it on screen, take only the new version.
        const next = pending ? { ...docRef.current, meta: saved.meta } : { meta: saved.meta, config: saved.config };
        docRef.current = next;
        setDoc(next);
        propsRef.current.onSaved?.(saved.meta);
        if (saved.conflictBackup) {
          if (propsRef.current.onConflictBackup) propsRef.current.onConflictBackup(saved.conflictBackup);
          else setInlineNote(translate("page.conflictKept", { path: saved.conflictBackup }));
        }
        if (!pending) propsRef.current.onSaveState?.("saved");
      },
      onConflict: () => {
        const { onSaveState } = propsRef.current;
        if (onSaveState) {
          onSaveState("conflict");
          return;
        }
        // An embed has no save bar: it asks in place (#hrdgchfb), and the change waits. The bar
        // takes focus only if the user was in this view; typing elsewhere on the page carries on,
        // and role="alert" announces it.
        const active = document.activeElement;
        focusInlineChoice.current = !!active && !!rootRef.current?.contains(active);
        setInlineNote(null);
        setInlineConflict(true);
      },
      onError: (error) => {
        void reloadFromDisk(docRef.current);
        propsRef.current.onError?.(errorText(error));
      },
      isConflict: (error) => error instanceof ApiRequestError && error.status === 409,
    });
  }

  // #wrr9fjn9: like a page's or a board's editor, a view's queued or in-flight change counts as
  // unsaved work: quitting (__gumplyFlush), History and a reload all flush it first.
  useEffect(() => {
    return registerSaver(pendingSaverFor(saverRef.current!));
  }, []);

  useEffect(() => {
    props.onReady?.({
      flush: () => saverRef.current!.flush(),
      isDirty: () => saverRef.current!.isDirty(),
      keepMine: () => saverRef.current!.keepMine(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Save a new config; only what changed is written (spec/api-bases). */
  const saveConfig = useCallback(async (next: BaseConfig) => {
    const shown = { ...docRef.current, config: next };
    docRef.current = shown;
    setDoc(shown);
    await saverRef.current!.save(next);
  }, []);

  const changeView = useCallback(
    (view: BaseViewConfig) => {
      if (!active) return;
      const current = docRef.current.config;
      void saveConfig({ ...current, views: current.views.map((item) => (item.name === active.name ? view : item)) });
      if (view.name !== active.name) setActiveName(view.name);
    },
    [active, saveConfig],
  );

  const editValue = useCallback(
    async (row: BaseRow, column: BaseColumn, value: BaseValue): Promise<boolean> => {
      if (!column.id.startsWith("note.")) return false;
      // Show it at once; the server's answer replaces it.
      setResult((current) =>
        current
          ? {
              ...current,
              rows: current.rows.map((item) =>
                item.id === row.id ? { ...item, values: { ...item.values, [column.id]: value } } : item,
              ),
            }
          : current,
      );
      let saved = true;
      try {
        await api.setPageProperties(row.id, { [column.id.slice(5)]: value }, row.updated);
      } catch (error) {
        saved = false;
        props.onError?.(errorText(error));
      }
      await load();
      return saved;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  /**
   * #7prbquxu (spec/database-tables §4, @opus-hunter's review): an owned database's column renamed or deleted
   * in every row of the database (the server's one job over the rows folder, not the view's rows). The base
   * names the new key only when every row followed; otherwise it's left as it was and the rows are named.
   */
  const titleList = (rows: ReadonlyArray<{ title: string }>) =>
    rows.length > 5 ? `${rows.slice(0, 5).map((row) => row.title).join(", ")}…` : rows.map((row) => row.title).join(", ");

  /** Run a database-wide column change: the server writes the rows and the base; the view takes the base it answers. */
  const changeRows = useCallback(
    async (change: { rename: { from: string; to: string } } | { remove: string }) => {
      // Our own pending view change goes first, so the server checks the base against what we last wrote.
      await saverRef.current?.flush();
      const result = await api.changeOwnedRowsProperty(baseId, change, { expectedUpdated: docRef.current.meta.updated, writer });
      saverRef.current?.setVersion(result.base.meta.updated);
      docRef.current = result.base;
      setDoc(result.base);
      return result;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseId, writer],
  );

  /** #7prbquxu phase 2: a block pasted into the grid, in one server request; refused rows are named. */
  const pasteRows = useCallback(
    async (rows: PastedRow[], columns?: { view: string; keys: string[] }, types?: Record<string, PropertyType>) => {
      try {
        await saverRef.current?.flush();
        const result = await api.pasteRows(baseId, rows, { expectedUpdated: docRef.current.meta.updated, writer, ...(columns ? { columns } : {}) });
        if (result.baseRefused) props.onError?.(t("bases.columnBaseChanged"));
        else if (!result.refused.length) {
          // New columns from the preview take their chosen type only where the vault has none.
          for (const [key, type] of Object.entries(types ?? {})) await api.setPropertyType(key, type, { ifAbsent: true }).catch(() => undefined);
        }
        if (columns) {
          // The server added the columns to the base: take it, with its version for the next save.
          const doc = await api.getBase(baseId);
          saverRef.current?.setVersion(doc.meta.updated);
          docRef.current = doc;
          setDoc(doc);
        }
        if (result.refused.length && !result.baseRefused) {
          const parts = [t("bases.pasteRefused", { titles: titleList(result.refused) })];
          if (result.trashed.length) parts.push(t("bases.pasteTrashed", { titles: titleList(result.trashed) }));
          if (result.stuck.length) parts.push(t("bases.pasteStuck", { titles: titleList(result.stuck) }));
          props.onError?.(parts.join(" "));
        }
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseId, writer, load],
  );

  const renameColumn = useCallback(
    async (column: BaseColumn, to: string) => {
      const from = column.id.slice(5);
      try {
        const result = await changeRows({ rename: { from, to } });
        if (result.clash.length) props.onError?.(t("bases.renameClash", { name: to, titles: titleList(result.clash) }));
        else if (result.skipped.length || result.baseRefused) {
          const failed = result.skipped.length
            ? t("bases.renameRowsFailed", { name: from, titles: titleList(result.skipped) })
            : t("bases.columnBaseChanged");
          // Rows that couldn't be put back keep the new name: say so, never silently half-renamed.
          props.onError?.(result.stuck.length ? `${failed} ${t("bases.renameStuck", { name: to, titles: titleList(result.stuck) })}` : failed);
        } else if (column.type && column.type !== "file" && column.type !== "formula") {
          // The new name takes the old one's type only when the types file has none for it (it may type other databases).
          await api.setPropertyType(to, column.type as PropertyType, { ifAbsent: true }).catch(() => undefined);
        }
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changeRows, load],
  );
  const deleteColumn = useCallback(
    async (column: BaseColumn) => {
      const key = column.id.slice(5);
      try {
        const result = await changeRows({ remove: key });
        // A row that kept its value keeps the column too.
        if (result.skipped.length) props.onError?.(t("bases.deleteRowsFailed", { name: key, titles: titleList(result.skipped) }));
        else if (result.baseRefused) props.onError?.(t("bases.columnBaseChanged"));
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [changeRows, load],
  );
  /**
   * A column's type. Select and Multi-select (#7prbquxu phase 3, spec §6) live in this base's properties,
   * seeded with the values its rows have (in the order they first appear, each its own colour); the types
   * file keeps text or a list (set only where it has none). Any other type is the vault's (types.json), and
   * leaving Select drops the options from the base.
   */
  const setColumnType = useCallback(
    async (column: BaseColumn, type: PropertyType | SelectKind) => {
      const key = column.id.slice(5);
      try {
        const config = docRef.current.config;
        if (type === "select" || type === "multiselect") {
          const settings = selectSettings(config, key);
          const options: SelectOption[] = settings ? [...settings.options] : [];
          for (const row of resultRef.current?.rows ?? []) {
            for (const value of selectedValues(row.values[column.id])) {
              if (!options.some((option) => option.value === value)) options.push({ value, color: nextOptionColor(options) });
            }
          }
          await saveConfig(withSelectSettings(config, key, { kind: type, options }));
          await api.setPropertyType(key, type === "select" ? "text" : "multitext", { ifAbsent: true }).catch(() => undefined);
        } else {
          if (selectSettings(config, key)) await saveConfig(withSelectSettings(config, key, null));
          await api.setPropertyType(key, type);
        }
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load, saveConfig],
  );

  /** Kanban drop, calendar move: one note property of one page. */
  const setValue = useCallback(
    async (row: BaseRow, key: string, value: BaseValue) => {
      const id = `note.${key}`;
      setResult((current) =>
        current
          ? { ...current, rows: current.rows.map((item) => (item.id === row.id ? { ...item, values: { ...item.values, [id]: value } } : item)) }
          : current,
      );
      try {
        await api.setPageProperties(row.id, { [key]: value }, row.updated);
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  const rename = useCallback(
    async (row: BaseRow, title: string): Promise<string | undefined> => {
      let id: string | undefined;
      try {
        id = (await api.updatePage(row.id, { title })).id;
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
      // #7prbquxu: the renamed row's id, so the database grid keeps it active.
      return id;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  /**
   * "+ New": a page in the source folder, with what the view's `is` filters need.
   * #7prbquxu: with `title` (the typing row), the row is made with that name and
   * nothing opens for renaming; it resolves once the table shows it.
   */
  const newRow = useCallback(async (implied?: Record<string, BaseValue>, title?: string): Promise<string | undefined> => {
    if (!active) return undefined;
    const source = baseSource(docRef.current.config);
    const parentId =
      source.kind === "folder" && source.folder
        ? source.folder
        : (props.pages.find((page) => page.id === baseId)?.parentId ?? null);
    try {
      const page = await api.createPage({ title: title ?? translate("defaults.untitledPage"), parentId });
      const values: Record<string, BaseValue> = {};
      for (const clause of viewClauses(active)) {
        if ("rule" in clause && clause.rule.op === "is" && clause.rule.property.startsWith("note.")) {
          values[clause.rule.property.slice(5)] = clause.rule.value;
        }
      }
      if (source.kind === "tag") values.tags = [source.tag];
      // The kanban column or calendar day it was added to.
      Object.assign(values, implied ?? {});
      if (Object.keys(values).length) await api.setPageProperties(page.id, values, page.updated);
      if (title !== undefined) {
        await load();
      } else if (active.type === "table") {
        setRenameRowId(page.id);
        await load();
      } else {
        // Other layouts have no title cell: open the page to name it.
        props.onOpen(page.id);
      }
      return page.id;
    } catch (error) {
      props.onError?.(errorText(error));
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, baseId, load, props.pages]);

  useEffect(() => {
    if (!inlineConflict || !focusInlineChoice.current) return;
    conflictRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [inlineConflict]);

  /** The inline choice closed: focus back on the view, never on <body>. */
  const focusView = () => rootRef.current?.focus({ preventScroll: true });
  const keepMineInline = async () => {
    setInlineConflict(false);
    focusView();
    await saverRef.current?.keepMine();
  };
  const reloadInline = async () => {
    setInlineConflict(false);
    focusView();
    await saverRef.current?.discard();
    await reloadFromDisk(docRef.current);
  };

  if (doc.error) {
    return (
      <div className="base-view">
        <div className="banner banner-error base-banner" role="alert" data-testid="base-broken">
          {t("bases.broken", { error: doc.error })}
        </div>
      </div>
    );
  }

  const drawn = active && DRAWN.includes(active.type);
  const maxHeight = embed ? ROW_HEIGHT * ((embed.maxRows ?? 10) + 2) + 2 : undefined;

  return (
    <BaseLinks.Provider value={baseLinks}>
    <div className={`base-view${embed ? " is-embedded" : ""}`} data-testid="base-view" ref={rootRef} tabIndex={-1}>
      {inlineConflict ? (
        <div className="banner base-banner base-conflict" role="alert" data-testid="base-conflict" ref={conflictRef}>
          <span>{t("bases.conflict")}</span>
          <button type="button" className="base-conflict-button" data-testid="base-conflict-keep-mine" onClick={() => void keepMineInline()}>
            {t("save.keepMine")}
          </button>
          <button type="button" className="base-conflict-button" data-testid="base-conflict-reload" onClick={() => void reloadInline()}>
            {t("save.reload")}
          </button>
        </div>
      ) : inlineNote ? (
        <div className="base-warning" role="status" data-testid="base-conflict-kept">
          {inlineNote}
        </div>
      ) : null}
      <div className="base-head">
        {embed ? null : (
          <ViewTabs
            views={views}
            active={active?.name ?? null}
            onSelect={setActiveName}
            dateProperty={result?.properties?.find((property) => property.type === "date" || property.type === "datetime")?.id}
            onChange={(nextViews, select) => {
              void saveConfig({ ...docRef.current.config, views: nextViews });
              if (select !== undefined) setActiveName(select);
            }}
          />
        )}
        {active && drawn ? (
          <ViewToolbar
            config={config}
            view={active}
            result={result}
            pages={props.pages}
            onChangeConfig={(next) => void saveConfig(next)}
            onChangeView={changeView}
            openRequest={openRequest}
            {...(ownedRowsFolder(config) && !embed ? { onImportCsv: () => csvInputRef.current?.click() } : {})}
          />
        ) : null}
      </div>

      {ownedRowsFolder(config) && !embed ? (
        <input
          ref={csvInputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          data-testid="base-import-csv-file"
          onChange={(event) => {
            const input = event.currentTarget;
            const file = input.files?.[0];
            input.value = "";
            if (!file) return;
            void file.text().then((text) => {
              const rows = parseCsv(text);
              if (rows.length && rows.some((row) => row.some((cell) => cell.trim() !== ""))) {
                setImportBlock((current) => ({ rows, n: (current?.n ?? 0) + 1 }));
              }
            });
          }}
        />
      ) : null}

      {!embed && views[0]?.type === "calendar" ? (
        // Obsidian opens a base (and `![[X.base]]`) on its first view, and has no Calendar (@opus-hunter, 1.14.4).
        <div className="base-warning" role="status" data-testid="base-calendar-first">
          <Icon name="info" size={14} />
          <span>{t("bases.calendarFirst")}</span>
        </div>
      ) : null}

      {result && result.warnings.length > 0 ? (
        <div className="base-warning" role="status" data-testid="base-warning">
          <Icon name="info" size={14} />
          <span>{t("bases.skipped", { what: result.warnings.join("; ") })}</span>
        </div>
      ) : null}

      {loadError ? (
        <div className="banner banner-error base-banner" role="alert" data-testid="base-load-error">
          {t("bases.loadFailed", { error: loadError })}
          <button type="button" className="link-button" onClick={() => void load()}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}

      {!active ? (
        <div className="base-empty">{t("bases.empty")}</div>
      ) : !drawn ? (
        <div className="base-notice" data-testid="base-unsupported">
          <Icon name={layoutIcon(active.type)} size={18} />
          <p>{t("bases.unsupportedView", { type: active.type })}</p>
        </div>
      ) : result && result.view === active.name && active.type !== "table" ? (
        (() => {
          const layout = {
            config,
            view: active,
            result,
            onOpen: props.onOpen,
            onSetValue: setValue,
            onNewRow: (values?: Record<string, BaseValue>) => void newRow(values),
          };
          switch (active.type) {
            case "kanban":
              return <KanbanView {...layout} onPickGroup={() => setOpenRequest((current) => ({ panel: "group", n: (current?.n ?? 0) + 1 }))} />;
            case "list":
              return <ListView {...layout} />;
            case "cards":
              return <CardsView {...layout} />;
            default:
              return <CalendarView {...layout} />;
          }
        })()
      ) : result && result.view === active.name ? (
        <TableView
          config={config}
          view={active}
          result={result}
          maxHeight={maxHeight}
          onOpen={props.onOpen}
          onEditValue={editValue}
          onRename={rename}
          onNewRow={() => void newRow()}
          {...(ownedRowsFolder(config)
            ? { onAddRow: (title: string) => newRow(undefined, title), importBlock, onRenameColumn: renameColumn, onPasteRows: (rows: PastedRow[]) => pasteRows(rows),
                onPastePreview: (previewed: PreviewResult, viewName: string) => pasteRows(previewed.rows, { view: viewName, keys: previewed.keys }, previewed.types), onDeleteColumn: deleteColumn, onSetColumnType: setColumnType }
            : {})}
          onChangeView={changeView}
          renameRowId={renameRowId}
          onRenameDone={() => setRenameRowId(null)}
        />
      ) : (
        <div className="base-loading" aria-busy="true" />
      )}
    </div>
    </BaseLinks.Provider>
  );
}

function uniqueName(name: string, views: readonly BaseViewConfig[]): string {
  const taken = new Set(views.map((view) => view.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) if (!taken.has(`${name} ${n}`.toLowerCase())) return `${name} ${n}`;
}

function ViewTabs(props: {
  views: BaseViewConfig[];
  active: string | null;
  onSelect: (name: string) => void;
  onChange: (views: BaseViewConfig[], select?: string) => void;
  /** A date property to start a new Calendar view on. */
  dateProperty?: string;
}) {
  const t = useT();
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ name: string; anchor: HTMLElement } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const { views } = props;

  const commitRename = () => {
    const from = renaming;
    setRenaming(null);
    const name = draft.trim();
    if (!from || !name || name === from) return;
    const unique = uniqueName(name, views.filter((view) => view.name !== from));
    props.onChange(
      views.map((view) => (view.name === from ? { ...view, name: unique } : view)),
      unique,
    );
  };

  return (
    <div className="base-tabs">
      {/* The tabs only: "+" (a button that opens a menu) sits outside the tablist (WCAG 1.3.1, #jchhjepb). */}
      <div className="base-tablist" role="tablist" aria-label={t("bases.views")}>
      {views.map((view) =>
        renaming === view.name ? (
          <input
            key={view.name}
            autoFocus
            className="base-tab-input"
            data-testid="base-tab-rename"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitRename();
              else if (event.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <button
            key={view.name}
            type="button"
            role="tab"
            aria-selected={props.active === view.name}
            className={`base-tab${props.active === view.name ? " is-active" : ""}`}
            data-testid={`base-tab-${view.name}`}
            onClick={(event) => {
              if (props.active === view.name) setMenu({ name: view.name, anchor: event.currentTarget });
              else props.onSelect(view.name);
            }}
            onDoubleClick={() => {
              setMenu(null);
              setDraft(view.name);
              setRenaming(view.name);
            }}
          >
            <Icon name={layoutIcon(view.type)} size={14} />
            <span>{view.name}</span>
          </button>
        ),
      )}
      </div>
      <button
        type="button"
        className="base-tab base-tab-add"
        data-testid="base-add-view"
        aria-label={t("bases.addView")}
        data-tooltip={t("bases.addView")}
        onClick={(event) => setAdding(event.currentTarget)}
      >
        <Icon name="plus" size={14} />
      </button>

      {adding ? (
        <Popover anchor={adding} onClose={() => setAdding(null)} label={t("bases.addView")} testId="base-add-view-menu" className="is-menu">
          {LAYOUTS.map((type) => (
            <button
              key={type}
              type="button"
              role="menuitem"
              data-testid={`base-add-view-${type}`}
              onClick={() => {
                setAdding(null);
                const name = uniqueName(t(`bases.newViewName.${type}` as MessageKey), views);
                const view: BaseViewConfig = { type, name, order: ["file.name"] };
                // Calendar: the vault's first date property, else the creation date.
                if (type === "calendar") view.dateProperty = props.dateProperty ?? "file.ctime";
                props.onChange([...views, view], name);
              }}
            >
              <Icon name={LAYOUT_ICONS[type]} size={14} />
              {t(`bases.viewType.${type}` as MessageKey)}
            </button>
          ))}
        </Popover>
      ) : null}

      {menu ? (
        <Popover anchor={menu.anchor} onClose={() => setMenu(null)} label={t("bases.viewMenu", { name: menu.name })} testId="base-view-menu" className="is-menu">
          <button
            type="button"
            role="menuitem"
            data-testid="base-rename-view"
            onClick={() => {
              setDraft(menu.name);
              setRenaming(menu.name);
              setMenu(null);
            }}
          >
            {t("bases.renameView")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-testid="base-duplicate-view"
            onClick={() => {
              const source = views.find((view) => view.name === menu.name);
              setMenu(null);
              if (!source) return;
              const name = uniqueName(t("bases.viewCopy", { name: source.name }), views);
              const at = views.indexOf(source);
              props.onChange([...views.slice(0, at + 1), { ...structuredClone(source), name }, ...views.slice(at + 1)], name);
            }}
          >
            {t("bases.duplicateView")}
          </button>
          {views.length > 1 ? (
            <button
              type="button"
              role="menuitem"
              className="menu-danger"
              data-testid="base-delete-view"
              onClick={() => {
                const rest = views.filter((view) => view.name !== menu.name);
                setMenu(null);
                props.onChange(rest, rest[0]?.name);
              }}
            >
              {t("bases.deleteView")}
            </button>
          ) : null}
        </Popover>
      ) : null}
    </div>
  );
}
