/**
 * A base view's toolbar (spec/api-bases): Source, Filter, Sort and Properties.
 * Every change is a new config, saved by BaseView; what the builder can't
 * show as a rule is listed as an expression and kept as written.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BaseConfig, BaseView, BaseViewResult, PageMeta } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { useT, type MessageKey } from "../i18n/index.js";
import { Popover } from "./Popover.js";
import { numberSetting, withSetting } from "./values.js";
import { propertyId } from "@gumply/core";
import { pickerProperties, propertyLabel, propertyType, writtenId } from "./labels.js";
import {
  baseSource,
  hasOtherGlobalFilters,
  opTakesValue,
  opsFor,
  viewClauses,
  withClauses,
  withSource,
  type BaseSource,
  type FilterClause,
  type RuleOp,
} from "./rules.js";

export type Panel = "source" | "filter" | "sort" | "group" | "properties" | "settings";

export interface ViewToolbarProps {
  config: BaseConfig;
  view: BaseView;
  result: BaseViewResult | null;
  pages: readonly PageMeta[];
  readOnly?: boolean;
  onChangeConfig: (config: BaseConfig) => void;
  onChangeView: (view: BaseView) => void;
  /** Open a panel from outside (Kanban's "Group by"); bump `n` to reopen. */
  openRequest?: { panel: Panel; n: number } | null;
}

export function ViewToolbar(props: ViewToolbarProps) {
  const t = useT();
  const [open, setOpen] = useState<Panel | null>(null);
  const anchors = useRef<Record<Panel, HTMLButtonElement | null>>({
    source: null,
    filter: null,
    sort: null,
    group: null,
    properties: null,
    settings: null,
  });
  useEffect(() => {
    if (props.openRequest) setOpen(props.openRequest.panel);
  }, [props.openRequest]);
  const { config, view, result } = props;
  const clauses = useMemo(() => viewClauses(view), [view]);
  const sorts = Array.isArray(view.sort) ? view.sort : [];
  const source = baseSource(config);
  const close = () => setOpen(null);

  const sourceLabel =
    source.kind === "folder"
      ? t("bases.sourceIn", { folder: source.folder })
      : source.kind === "tag"
        ? t("bases.sourceTagged", { tag: source.tag })
        : t("bases.sourceAll");

  const button = (panel: Panel, icon: Parameters<typeof Icon>[0]["name"], label: string, count = 0) => (
    <button
      type="button"
      ref={(element) => {
        anchors.current[panel] = element;
      }}
      className={`base-tool${count > 0 ? " is-active" : ""}${open === panel ? " is-open" : ""}`}
      data-testid={`base-${panel}-button`}
      aria-haspopup="dialog"
      aria-expanded={open === panel}
      disabled={props.readOnly}
      onClick={() => setOpen((current) => (current === panel ? null : panel))}
    >
      <Icon name={icon} size={14} />
      <span>{label}</span>
      {count > 0 ? <span className="base-tool-count">{count}</span> : null}
    </button>
  );

  return (
    <div className="base-toolbar" role="toolbar" aria-label={view.name}>
      <span className="base-tool-anchor">
        {button("source", "folder", sourceLabel)}
        {open === "source" ? (
          <SourcePanel
            anchor={anchors.current.source}
            config={config}
            source={source}
            pages={props.pages}
            onClose={close}
            onChange={(next) => props.onChangeConfig(withSource(config, next))}
          />
        ) : null}
      </span>
      <span className="base-tool-anchor">
        {button("filter", "filter", t("bases.filter"), clauses.length)}
        {open === "filter" ? (
          <FilterPanel
            anchor={anchors.current.filter}
            config={config}
            result={result}
            clauses={clauses}
            onClose={close}
            onChange={(next) => props.onChangeView(withClauses(view, next, (id) => propertyType(id, result)))}
          />
        ) : null}
      </span>
      <span className="base-tool-anchor">
        {button("sort", "sort", t("bases.sort"), sorts.length)}
        {open === "sort" ? (
          <SortPanel
            anchor={anchors.current.sort}
            config={config}
            result={result}
            view={view}
            onClose={close}
            onChange={props.onChangeView}
          />
        ) : null}
      </span>
      {view.type === "calendar" ? null : (
        <span className="base-tool-anchor">
          {button("group", "kanban", t("bases.group"), view.groupBy?.property ? 1 : 0)}
          {open === "group" ? (
            <GroupPanel anchor={anchors.current.group} config={config} result={result} view={view} onClose={close} onChange={props.onChangeView} />
          ) : null}
        </span>
      )}
      <span className="base-tool-anchor">
        {button("properties", "list", t("bases.properties"))}
        {open === "properties" ? (
          <PropertiesPanel
            anchor={anchors.current.properties}
            config={config}
            result={result}
            view={view}
            onClose={close}
            onChange={props.onChangeView}
          />
        ) : null}
      </span>
      <span className="base-tool-anchor">
        {button("settings", "more", t("bases.layout"))}
        {open === "settings" ? (
          <SettingsPanel anchor={anchors.current.settings} config={config} result={result} view={view} onClose={close} onChange={props.onChangeView} />
        ) : null}
      </span>
    </div>
  );
}

function GroupPanel(props: {
  anchor: HTMLElement | null;
  config: BaseConfig;
  result: BaseViewResult | null;
  view: BaseView;
  onClose: () => void;
  onChange: (view: BaseView) => void;
}) {
  const t = useT();
  const { view } = props;
  const options = pickerProperties(props.config, props.result);
  const current = view.groupBy?.property ? propertyId(String(view.groupBy.property)) : "";
  const direction = view.groupBy?.direction === "DESC" ? "DESC" : "ASC";
  const set = (property: string, nextDirection: "ASC" | "DESC") => {
    const next: BaseView = { ...view };
    if (!property) {
      delete next.groupBy;
      delete next.groupOrder;
    } else {
      next.groupBy = { property: writtenId(property), direction: nextDirection };
      // Another property's column order means nothing for this one.
      if (property !== current) delete next.groupOrder;
    }
    props.onChange(next);
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.group")} testId="base-group-panel" className="is-wide">
      <div className="base-rule">
        <span className="base-rule-lead">{t("bases.groupBy")}</span>
        <select
          className="base-select"
          aria-label={t("bases.groupBy")}
          data-testid="base-group-property"
          value={current}
          onChange={(event) => set(event.target.value, direction)}
        >
          <option value="">{t("bases.noGroup")}</option>
          {(current && !options.includes(current) ? [current, ...options] : options).map((id) => (
            <option key={id} value={id}>
              {propertyLabel(id, props.config, t)}
            </option>
          ))}
        </select>
        {current ? (
          <select
            className="base-select"
            aria-label={t("bases.sort")}
            data-testid="base-group-direction"
            value={direction}
            onChange={(event) => set(current, event.target.value as "ASC" | "DESC")}
          >
            <option value="ASC">{t("bases.ascending")}</option>
            <option value="DESC">{t("bases.descending")}</option>
          </select>
        ) : null}
      </div>
    </Popover>
  );
}

/** Obsidian 1.14.4's per-layout settings and defaults (spec/api-bases). */
function SettingsPanel(props: {
  anchor: HTMLElement | null;
  config: BaseConfig;
  result: BaseViewResult | null;
  view: BaseView;
  onClose: () => void;
  onChange: (view: BaseView) => void;
}) {
  const t = useT();
  const { view } = props;
  const set = (key: string, value: unknown, fallback: unknown) => props.onChange(withSetting(view, key, value, fallback));
  const options = pickerProperties(props.config, props.result).filter((id) => !id.startsWith("file.") || id === "file.file");
  const number = (key: string, label: string, fallback: number, min: number, max: number, step: number) => (
    <label className="base-setting">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        data-testid={`base-setting-${key}`}
        value={numberSetting(view, key, fallback, min, max)}
        onChange={(event) => set(key, Number(event.target.value), fallback)}
      />
      <output>{numberSetting(view, key, fallback, min, max)}</output>
    </label>
  );
  const image = (ratioDefault: number) => (
    <>
      <label className="base-setting">
        <span>{t("bases.setting.image")}</span>
        <select
          className="base-select"
          data-testid="base-setting-image"
          value={typeof view.image === "string" ? propertyId(view.image) : ""}
          onChange={(event) => set("image", event.target.value || undefined, undefined)}
        >
          <option value="">{t("bases.noGroup")}</option>
          {options.map((id) => (
            <option key={id} value={id}>
              {propertyLabel(id, props.config, t)}
            </option>
          ))}
        </select>
      </label>
      <label className="base-setting">
        <span>{t("bases.setting.imageFit")}</span>
        <select
          className="base-select"
          data-testid="base-setting-imageFit"
          value={view.imageFit === "contain" ? "contain" : ""}
          onChange={(event) => set("imageFit", event.target.value, "")}
        >
          <option value="">{t("bases.setting.cover")}</option>
          <option value="contain">{t("bases.setting.contain")}</option>
        </select>
      </label>
      {number("imageAspectRatio", t("bases.setting.imageAspectRatio"), ratioDefault, 0.25, 2.5, 0.05)}
    </>
  );

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.layout")} testId="base-settings-panel">
      <div className="base-panel-title">{t(`bases.viewType.${["table", "kanban", "list", "cards", "calendar"].includes(view.type) ? view.type : "table"}` as MessageKey)}</div>
      {view.type === "table" ? (
        <label className="base-setting">
          <span>{t("bases.setting.rowHeight")}</span>
          <select
            className="base-select"
            data-testid="base-setting-rowHeight"
            value={typeof view.rowHeight === "string" ? view.rowHeight : "short"}
            onChange={(event) => set("rowHeight", event.target.value, "short")}
          >
            {(["short", "medium", "tall", "extra"] as const).map((value) => (
              <option key={value} value={value}>
                {t(`bases.setting.height.${value}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {view.type === "cards" ? (
        <>
          {number("cardSize", t("bases.setting.cardSize"), 200, 50, 800, 10)}
          {image(1)}
        </>
      ) : null}
      {view.type === "kanban" ? (
        <>
          {number("columnWidth", t("bases.setting.columnWidth"), 280, 200, 500, 10)}
          {image(0.5)}
        </>
      ) : null}
      {view.type === "list" ? (
        <>
          <label className="base-setting">
            <span>{t("bases.setting.markers")}</span>
            <select
              className="base-select"
              data-testid="base-setting-markers"
              value={view.markers === "number" || view.markers === "none" ? view.markers : "bullet"}
              onChange={(event) => set("markers", event.target.value, "bullet")}
            >
              {(["bullet", "number", "none"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`bases.setting.marker.${value}` as MessageKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="base-check">
            <input
              type="checkbox"
              data-testid="base-setting-indentProperties"
              checked={view.indentProperties === true}
              onChange={(event) => set("indentProperties", event.target.checked, false)}
            />
            <span>{t("bases.setting.indentProperties")}</span>
          </label>
          {view.indentProperties === true ? null : (
            <label className="base-setting">
              <span>{t("bases.setting.separator")}</span>
              <input
                className="base-input"
                data-testid="base-setting-separator"
                defaultValue={typeof view.separator === "string" ? view.separator : ", "}
                onBlur={(event) => set("separator", event.target.value, ", ")}
              />
            </label>
          )}
        </>
      ) : null}
      {view.type === "calendar" ? (
        <>
          {(["dateProperty", "endDateProperty"] as const).map((key) => (
            <label className="base-setting" key={key}>
              <span>{t(`bases.setting.${key}` as MessageKey)}</span>
              <select
                className="base-select"
                data-testid={`base-setting-${key}`}
                value={typeof view[key] === "string" ? propertyId(view[key] as string) : key === "dateProperty" ? "file.ctime" : ""}
                onChange={(event) => set(key, event.target.value || undefined, undefined)}
              >
                {key === "endDateProperty" ? <option value="">{t("bases.noGroup")}</option> : null}
                {pickerProperties(props.config, props.result)
                  .filter((id) => ["date", "datetime"].includes(propertyType(id, props.result)))
                  .map((id) => (
                    <option key={id} value={id}>
                      {propertyLabel(id, props.config, t)}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </>
      ) : null}
    </Popover>
  );
}

function PropertySelect(props: {
  value: string;
  options: string[];
  config: BaseConfig;
  label: string;
  testId: string;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const options = props.options.includes(props.value) ? props.options : [props.value, ...props.options];
  return (
    <select
      className="base-select"
      aria-label={props.label}
      data-testid={props.testId}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {options.map((id) => (
        <option key={id} value={id}>
          {propertyLabel(id, props.config, t)}
        </option>
      ))}
    </select>
  );
}

function SourcePanel(props: {
  anchor: HTMLElement | null;
  config: BaseConfig;
  source: BaseSource;
  pages: readonly PageMeta[];
  onClose: () => void;
  onChange: (source: BaseSource) => void;
}) {
  const t = useT();
  const [tag, setTag] = useState(props.source.kind === "tag" ? props.source.tag : "");
  // Folders: folder pages and plain folders (D33), by path.
  const folders = useMemo(
    () =>
      props.pages
        .filter((page) => page.kind === "folder" || props.pages.some((child) => child.parentId === page.id))
        .map((page) => page.id)
        .sort((a, b) => a.localeCompare(b)),
    [props.pages],
  );
  const kind = props.source.kind;
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.source")} testId="base-source-panel">
      <div className="base-panel-title">{t("bases.source")}</div>
      <label className="base-radio">
        <input type="radio" name="base-source" checked={kind === "all"} onChange={() => props.onChange({ kind: "all" })} />
        {t("bases.sourceAll")}
      </label>
      <label className="base-radio">
        <input
          type="radio"
          name="base-source"
          checked={kind === "folder"}
          onChange={() => props.onChange({ kind: "folder", folder: folders[0] ?? "" })}
        />
        {t("bases.sourceFolder")}
      </label>
      {kind === "folder" ? (
        <select
          className="base-select base-source-field"
          aria-label={t("bases.folderPlaceholder")}
          data-testid="base-source-folder"
          value={props.source.kind === "folder" ? props.source.folder : ""}
          onChange={(event) => props.onChange({ kind: "folder", folder: event.target.value })}
        >
          {(props.source.kind === "folder" && !folders.includes(props.source.folder)
            ? [props.source.folder, ...folders]
            : folders
          ).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
      ) : null}
      <label className="base-radio">
        <input
          type="radio"
          name="base-source"
          checked={kind === "tag"}
          onChange={() => tag.trim() && props.onChange({ kind: "tag", tag: tag.trim() })}
        />
        {t("bases.sourceTag")}
      </label>
      <input
        className="base-input base-source-field"
        aria-label={t("bases.tagPlaceholder")}
        placeholder={t("bases.tagPlaceholder")}
        data-testid="base-source-tag"
        value={tag}
        onChange={(event) => setTag(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && tag.trim()) props.onChange({ kind: "tag", tag: tag.trim().replace(/^#/, "") });
        }}
        onBlur={() => {
          const clean = tag.trim().replace(/^#/, "");
          if (clean && (kind === "tag" ? props.source.kind === "tag" && props.source.tag !== clean : false)) {
            props.onChange({ kind: "tag", tag: clean });
          }
        }}
      />
      {hasOtherGlobalFilters(props.config) ? <p className="base-panel-note">{t("bases.sourceMore")}</p> : null}
    </Popover>
  );
}

function FilterPanel(props: {
  anchor: HTMLElement | null;
  config: BaseConfig;
  result: BaseViewResult | null;
  clauses: FilterClause[];
  onClose: () => void;
  onChange: (clauses: FilterClause[]) => void;
}) {
  const t = useT();
  const options = pickerProperties(props.config, props.result);
  // Rules still waiting for a value stay here; only complete ones are written
  // (an empty `status == ""` would hide every row).
  const [clauses, setClauses] = useState<FilterClause[]>(props.clauses);
  const apply = (next: FilterClause[]) => {
    setClauses(next);
    const written = next.filter((clause) => !("rule" in clause) || !opTakesValue(clause.rule.op) || clause.rule.value.trim() !== "");
    if (JSON.stringify(written) !== JSON.stringify(props.clauses)) props.onChange(written);
  };
  const update = (index: number, clause: FilterClause) => apply(clauses.map((item, i) => (i === index ? clause : item)));
  const remove = (index: number) => apply(clauses.filter((_, i) => i !== index));

  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.filter")} testId="base-filter-panel" className="is-wide">
      {clauses.length === 0 ? <p className="base-panel-note">{t("bases.noRules")}</p> : null}
      {clauses.map((clause, index) => (
        <div className="base-rule" key={index} data-testid="base-rule">
          <span className="base-rule-lead">{index === 0 ? t("bases.where") : t("bases.and")}</span>
          {"rule" in clause ? (
            <RuleEditor
              config={props.config}
              result={props.result}
              options={options}
              rule={clause.rule}
              onChange={(rule) => update(index, { rule })}
            />
          ) : (
            <code className="base-rule-raw" title={t("bases.expression")} data-testid="base-rule-raw">
              {typeof clause.raw === "string" ? clause.raw : JSON.stringify(clause.raw)}
            </code>
          )}
          <button
            type="button"
            className="icon-button base-rule-remove"
            aria-label={t("bases.removeRule")}
            data-tooltip={t("bases.removeRule")}
            onClick={() => remove(index)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="base-add"
        data-testid="base-add-rule"
        onClick={() => {
          const property = options.find((id) => id.startsWith("note.")) ?? "file.name";
          const op = opsFor(propertyType(property, props.result))[0]!;
          apply([...clauses, { rule: { property, op, value: "" } }]);
        }}
      >
        <Icon name="plus" size={14} />
        {t("bases.addRule")}
      </button>
    </Popover>
  );
}

function RuleEditor(props: {
  config: BaseConfig;
  result: BaseViewResult | null;
  options: string[];
  rule: { property: string; op: RuleOp; value: string };
  onChange: (rule: { property: string; op: RuleOp; value: string }) => void;
}) {
  const t = useT();
  const { rule } = props;
  const type = propertyType(rule.property, props.result);
  const ops = opsFor(type);
  const [draft, setDraft] = useState(rule.value);
  const commit = () => {
    if (draft !== rule.value) props.onChange({ ...rule, value: draft });
  };
  return (
    <>
      <PropertySelect
        value={rule.property}
        options={props.options}
        config={props.config}
        label={t("bases.properties")}
        testId="base-rule-property"
        onChange={(property) => {
          const nextOps = opsFor(propertyType(property, props.result));
          props.onChange({ property, op: nextOps.includes(rule.op) ? rule.op : nextOps[0]!, value: rule.value });
        }}
      />
      <select
        className="base-select"
        aria-label={t("bases.filter")}
        data-testid="base-rule-op"
        value={rule.op}
        onChange={(event) => props.onChange({ ...rule, op: event.target.value as RuleOp })}
      >
        {(ops.includes(rule.op) ? ops : [rule.op, ...ops]).map((op) => (
          <option key={op} value={op}>
            {t(`bases.op.${op}` as MessageKey)}
          </option>
        ))}
      </select>
      {opTakesValue(rule.op) ? (
        <input
          className="base-input"
          data-testid="base-rule-value"
          aria-label={t("bases.valuePlaceholder")}
          placeholder={t("bases.valuePlaceholder")}
          type={type === "date" ? "date" : type === "datetime" ? "datetime-local" : type === "number" ? "number" : "text"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      ) : null}
    </>
  );
}

function SortPanel(props: {
  anchor: HTMLElement | null;
  config: BaseConfig;
  result: BaseViewResult | null;
  view: BaseView;
  onClose: () => void;
  onChange: (view: BaseView) => void;
}) {
  const t = useT();
  const sorts = Array.isArray(props.view.sort) ? props.view.sort : [];
  const options = pickerProperties(props.config, props.result);
  const set = (next: typeof sorts) => {
    const view: BaseView = { ...props.view };
    if (next.length) view.sort = next;
    else delete view.sort;
    props.onChange(view);
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.sort")} testId="base-sort-panel" className="is-wide">
      {sorts.length === 0 ? <p className="base-panel-note">{t("bases.noSorts")}</p> : null}
      {sorts.map((sort, index) => (
        <div className="base-rule" key={index} data-testid="base-sort">
          <PropertySelect
            value={propertyId(String(sort.property))}
            options={options}
            config={props.config}
            label={t("bases.sort")}
            testId="base-sort-property"
            onChange={(property) => set(sorts.map((item, i) => (i === index ? { ...item, property: writtenId(property) } : item)))}
          />
          <select
            className="base-select"
            aria-label={t("bases.sort")}
            data-testid="base-sort-direction"
            value={sort.direction}
            onChange={(event) =>
              set(sorts.map((item, i) => (i === index ? { ...item, direction: event.target.value as "ASC" | "DESC" } : item)))
            }
          >
            <option value="ASC">{t("bases.ascending")}</option>
            <option value="DESC">{t("bases.descending")}</option>
          </select>
          <button
            type="button"
            className="icon-button base-rule-remove"
            aria-label={t("bases.removeSort")}
            data-tooltip={t("bases.removeSort")}
            onClick={() => set(sorts.filter((_, i) => i !== index))}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="base-add"
        data-testid="base-add-sort"
        onClick={() => {
          const used = new Set(sorts.map((sort) => propertyId(String(sort.property))));
          const property = options.find((id) => !used.has(id)) ?? "file.name";
          set([...sorts, { property: writtenId(property), direction: "ASC" }]);
        }}
      >
        <Icon name="plus" size={14} />
        {t("bases.addSort")}
      </button>
    </Popover>
  );
}

function PropertiesPanel(props: {
  anchor: HTMLElement | null;
  config: BaseConfig;
  result: BaseViewResult | null;
  view: BaseView;
  onClose: () => void;
  onChange: (view: BaseView) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const order = Array.isArray(props.view.order) && props.view.order.length ? props.view.order.map(String) : ["file.name"];
  const normalised = order.map((id) => propertyId(id));
  const all = pickerProperties(props.config, props.result);
  const shown = (id: string) => normalised.includes(id);
  const visible = all.filter((id) => propertyLabel(id, props.config, t).toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) => {
    const index = normalised.indexOf(id);
    // Keep the ids as written in the file (`status` stays `status`).
    const next = index >= 0 ? order.filter((_, i) => i !== index) : [...order, writtenId(id)];
    props.onChange({ ...props.view, order: next });
  };
  return (
    <Popover anchor={props.anchor} onClose={props.onClose} label={t("bases.properties")} testId="base-properties-panel">
      <input
        className="base-input"
        placeholder={t("bases.searchProperties")}
        aria-label={t("bases.searchProperties")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="base-panel-title">{t("bases.shownProperties")}</div>
      <div className="base-property-list">
        {visible.map((id) => (
          <label className="base-check" key={id}>
            <input type="checkbox" checked={shown(id)} data-testid={`base-property-${id}`} onChange={() => toggle(id)} />
            <span>{propertyLabel(id, props.config, t)}</span>
          </label>
        ))}
      </div>
    </Popover>
  );
}
