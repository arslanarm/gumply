/**
 * A database view (D34, spec/api-bases, #sg36ng2d): the tabs of a `.base`
 * file's views, the toolbar, and the open view's layout.
 *
 * The server runs the view (`GET /bases/:id/view`); this component only
 * shows it and turns edits into a new config (`PUT /bases/:id`, which writes
 * only what changed) or a page's properties (`PUT /pages/:id`, v1.12).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaseColumn, BaseConfig, BaseRow, BaseValue, BaseView as BaseViewConfig, BaseViewResult, PageId, PageMeta } from "@gumply/core";
import { api, ApiRequestError, type BaseDocument } from "../api/client.js";
import { Icon, type IconName } from "../components/Icon.js";
import { t as translate, useT, type MessageKey } from "../i18n/index.js";
import { Popover } from "./Popover.js";
import { TableView, ROW_HEIGHT } from "./TableView.js";
import { ViewToolbar } from "./ViewToolbar.js";
import { baseSource, viewClauses } from "./rules.js";
import "./bases.css";

const LAYOUTS = ["table", "kanban", "list", "cards", "calendar"] as const;
type Layout = (typeof LAYOUTS)[number];
/** Layouts this version draws; the others are kept in the file and listed. */
const DRAWN: readonly string[] = ["table"];

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
}

export function BaseView(props: BaseViewProps) {
  const t = useT();
  const { baseId, embed } = props;
  const [doc, setDoc] = useState<BaseDocument>(props.initial);
  const docRef = useRef(doc);
  docRef.current = doc;
  const config = doc.config;
  const views = config.views;
  const [activeName, setActiveName] = useState<string | null>(() => embed?.viewName ?? views[0]?.name ?? null);
  const active = views.find((view) => view.name === activeName) ?? views[0] ?? null;
  const [result, setResult] = useState<BaseViewResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [renameRowId, setRenameRowId] = useState<string | null>(null);
  const writer = useMemo(() => `base-${Math.random().toString(36).slice(2, 10)}`, []);
  const requestSeq = useRef(0);

  useEffect(() => {
    setDoc(props.initial);
  }, [props.initial]);

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

  // …and again, debounced, when pages in the vault changed.
  const firstRefresh = useRef(true);
  useEffect(() => {
    if (firstRefresh.current) {
      firstRefresh.current = false;
      return;
    }
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.refreshKey]);

  /** Save a new config; only what changed is written (spec/api-bases). */
  const saveConfig = useCallback(
    async (next: BaseConfig) => {
      const current = docRef.current;
      setDoc({ ...current, config: next });
      try {
        const saved = await api.saveBase(baseId, { config: next, expectedUpdated: current.meta.updated, writer });
        setDoc({ meta: saved.meta, config: saved.config });
        props.onSaved?.(saved.meta);
      } catch (error) {
        // Changed on disk (or failed): show the file as it is now.
        try {
          setDoc(await api.getBase(baseId));
        } catch {
          setDoc(current);
        }
        props.onError?.(
          error instanceof ApiRequestError && error.status === 409 ? translate("save.conflictLong") : errorText(error),
        );
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseId, writer],
  );

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
    async (row: BaseRow, column: BaseColumn, value: BaseValue) => {
      if (!column.id.startsWith("note.")) return;
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
      try {
        await api.setPageProperties(row.id, { [column.id.slice(5)]: value }, row.updated);
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  const rename = useCallback(
    async (row: BaseRow, title: string) => {
      try {
        await api.updatePage(row.id, { title });
      } catch (error) {
        props.onError?.(errorText(error));
      }
      await load();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [load],
  );

  /** "+ New": a page in the source folder, with what the view's `is` filters need. */
  const newRow = useCallback(async () => {
    if (!active) return;
    const source = baseSource(docRef.current.config);
    const parentId =
      source.kind === "folder" && source.folder
        ? source.folder
        : (props.pages.find((page) => page.id === baseId)?.parentId ?? null);
    try {
      const page = await api.createPage({ title: translate("defaults.untitledPage"), parentId });
      const values: Record<string, BaseValue> = {};
      for (const clause of viewClauses(active)) {
        if ("rule" in clause && clause.rule.op === "is" && clause.rule.property.startsWith("note.")) {
          values[clause.rule.property.slice(5)] = clause.rule.value;
        }
      }
      if (source.kind === "tag") values.tags = [source.tag];
      if (Object.keys(values).length) await api.setPageProperties(page.id, values, page.updated);
      setRenameRowId(page.id);
      await load();
    } catch (error) {
      props.onError?.(errorText(error));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, baseId, load, props.pages]);

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
    <div className={`base-view${embed ? " is-embedded" : ""}`} data-testid="base-view">
      <div className="base-head">
        {embed ? null : (
          <ViewTabs
            views={views}
            active={active?.name ?? null}
            onSelect={setActiveName}
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
          />
        ) : null}
      </div>

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
          <p>
            {(LAYOUTS as readonly string[]).includes(active.type)
              ? t("bases.notYet")
              : t("bases.unsupportedView", { type: active.type })}
          </p>
        </div>
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
          onChangeView={changeView}
          renameRowId={renameRowId}
          onRenameDone={() => setRenameRowId(null)}
        />
      ) : (
        <div className="base-loading" aria-busy="true" />
      )}
    </div>
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
    <div className="base-tabs" role="tablist" aria-label={t("bases.views")}>
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
                if (type === "calendar") view.dateProperty = "file.ctime";
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
