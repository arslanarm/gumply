/**
 * Run one view of a base over indexed pages (spec/api-bases, #sg36ng2d):
 * filters, formulas, sort, group, limit and summaries. Pure, so the server,
 * tests and (later) previews share it.
 *
 * An expression Gumply can't evaluate is skipped and reported in `warnings`:
 * a skipped filter lets rows through (it never hides them silently), a skipped
 * formula is empty.
 */
import type { BaseConfig, BaseFilter, BaseView, BaseViewType } from "./format.js";
import {
  UnsupportedError,
  compareValues,
  evaluateExpression,
  formatDate,
  isDate,
  isEmptyValue,
  isTruthy,
  parseDate,
  valueToString,
  type EvalContext,
  type FileInfo,
  type Value,
} from "./expr.js";

export type BaseValue = string | number | boolean | string[] | null;

export interface BaseSourceRow {
  id: string;
  kind: string;
  title: string;
  icon?: string;
  updated: string;
  file: FileInfo;
}

export interface BaseColumn {
  /** `file.name`, `note.status`, `formula.total`. */
  id: string;
  /** `properties.<id>.displayName`, when the base sets one. */
  displayName?: string;
  /** A note property's type (v1.12), else `"formula"` or `"file"`. */
  type: string;
  /** Only note properties are written from a view. */
  editable: boolean;
}

export interface BaseRow {
  id: string;
  kind: string;
  title: string;
  icon?: string;
  updated: string;
  values: Record<string, BaseValue>;
}

export interface BaseGroup {
  value: BaseValue;
  /** Shown as the column or section title; `""` for "no value". */
  label: string;
  /** Indexes into `rows`. */
  rows: number[];
}

export interface BaseViewResult {
  view: string;
  type: BaseViewType;
  columns: BaseColumn[];
  rows: BaseRow[];
  groups?: BaseGroup[];
  summaries?: Record<string, string>;
  total: number;
  warnings: string[];
}

export interface RunBaseOptions {
  config: BaseConfig;
  /** View name; the first view when absent or not found. */
  view?: string;
  rows: readonly BaseSourceRow[];
  /** `this`: the base itself, or the page it's embedded in. */
  thisFile?: FileInfo;
  /** Property types by key (v1.12); untyped keys are "text". */
  types?: ReadonlyMap<string, string>;
  now?: number;
  resolveLink?: (target: string) => string | null;
}

/** `status` → `note.status`; `file.x` and `formula.x` stay. */
export function propertyId(id: string): string {
  if (id.startsWith("note.") || id.startsWith("file.") || id.startsWith("formula.")) return id;
  return `note.${id}`;
}

/** The note key of `note.status` (or `null` for file and formula ids). */
export function noteKey(id: string): string | null {
  const full = propertyId(id);
  return full.startsWith("note.") ? full.slice(5) : null;
}

/** A view value as JSON: dates as `YYYY-MM-DD[THH:mm]`, links as their text. */
export function toBaseValue(value: Value): BaseValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (Array.isArray(value)) return value.map(valueToString);
  if (isDate(value)) return formatDate(value);
  if (value.$t === "note") return null;
  return valueToString(value);
}

const BUILTIN_SUMMARIES = new Set([
  "Average",
  "Min",
  "Max",
  "Sum",
  "Range",
  "Median",
  "Stddev",
  "Earliest",
  "Latest",
  "Checked",
  "Unchecked",
  "Empty",
  "Filled",
  "Unique",
]);

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

function builtinSummary(name: string, values: Value[]): string {
  const filled = values.filter((value) => !isEmptyValue(value));
  const numbers = filled
    .map((value) => (typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN))
    .filter((value) => Number.isFinite(value));
  const dates = filled.map((value) => (isDate(value) ? value : null)).filter((value) => value !== null);
  switch (name) {
    case "Empty":
      return String(values.length - filled.length);
    case "Filled":
      return String(filled.length);
    case "Unique":
      return String(new Set(filled.map(valueToString)).size);
    case "Checked":
      return String(values.filter((value) => value === true).length);
    case "Unchecked":
      return String(values.filter((value) => value !== true).length);
    case "Earliest":
    case "Latest": {
      if (!dates.length) return "";
      const pick = dates.reduce((a, b) => ((name === "Earliest" ? a.ms <= b.ms : a.ms >= b.ms) ? a : b));
      return formatDate(pick);
    }
  }
  if (!numbers.length) return "";
  const sum = numbers.reduce((a, b) => a + b, 0);
  const mean = sum / numbers.length;
  switch (name) {
    case "Sum":
      return formatNumber(sum);
    case "Average":
      return formatNumber(mean);
    case "Min":
      return formatNumber(Math.min(...numbers));
    case "Max":
      return formatNumber(Math.max(...numbers));
    case "Range":
      return formatNumber(Math.max(...numbers) - Math.min(...numbers));
    case "Median": {
      const sorted = [...numbers].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      return formatNumber(sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2);
    }
    case "Stddev":
      return formatNumber(Math.sqrt(numbers.reduce((acc, n) => acc + (n - mean) ** 2, 0) / numbers.length));
    default:
      return "";
  }
}

export function runBaseView(options: RunBaseOptions): BaseViewResult {
  const { config } = options;
  const view: BaseView =
    config.views.find((candidate) => candidate.name === options.view) ?? config.views[0] ?? { type: "table", name: "Table" };
  const now = options.now ?? Date.now();
  const warnings = new Set<string>();
  const formulas = config.formulas ?? {};

  const contextFor = (row: BaseSourceRow): EvalContext => {
    const cache = new Map<string, Value>();
    const stack = new Set<string>();
    const ctx: EvalContext = {
      file: row.file,
      thisFile: options.thisFile,
      now,
      resolveLink: options.resolveLink,
      formula: (name) => {
        if (cache.has(name)) return cache.get(name)!;
        const source = Object.hasOwn(formulas, name) ? formulas[name] : undefined;
        if (typeof source !== "string") throw new UnsupportedError(`formula.${name} isn't defined`);
        if (stack.has(name)) throw new UnsupportedError(`formula.${name} refers to itself`);
        stack.add(name);
        try {
          const value = evaluateExpression(source, ctx);
          cache.set(name, value);
          return value;
        } finally {
          stack.delete(name);
        }
      },
    };
    return ctx;
  };

  const safely = (source: string, run: () => Value): Value | undefined => {
    try {
      return run();
    } catch (error) {
      if (error instanceof UnsupportedError) {
        warnings.add(`${source.trim()}: ${error.message}`);
        return undefined;
      }
      throw error;
    }
  };

  /** `true`/`false`, or `null` when the filter is skipped. */
  const test = (filter: BaseFilter | undefined, ctx: EvalContext): boolean | null => {
    if (filter === undefined) return null;
    if (typeof filter === "string") {
      if (!filter.trim()) return null;
      const value = safely(filter, () => evaluateExpression(filter, ctx));
      return value === undefined ? null : isTruthy(value);
    }
    if ("and" in filter) {
      const results = filter.and.map((item) => test(item, ctx)).filter((result) => result !== null);
      return results.length ? results.every(Boolean) : null;
    }
    if ("or" in filter) {
      const results = filter.or.map((item) => test(item, ctx)).filter((result) => result !== null);
      return results.length ? results.some(Boolean) : null;
    }
    const results = filter.not.map((item) => test(item, ctx)).filter((result) => result !== null);
    return results.length ? !results.some(Boolean) : null;
  };

  const valueOf = (id: string, ctx: EvalContext): Value => {
    const key = noteKey(id);
    if (key !== null) return ctx.file.props.get(key) ?? null;
    if (id.startsWith("formula.")) {
      const name = id.slice("formula.".length);
      const source = Object.hasOwn(formulas, name) ? formulas[name]! : id;
      return safely(source, () => ctx.formula!(name)) ?? null;
    }
    return safely(id, () => evaluateExpression(id, ctx)) ?? null;
  };

  // Filter.
  const matched: { row: BaseSourceRow; ctx: EvalContext }[] = [];
  for (const row of options.rows) {
    const ctx = contextFor(row);
    if (test(config.filters, ctx) === false || test(view.filters, ctx) === false) continue;
    matched.push({ row, ctx });
  }

  // Sort: the view's sorts, then the name, so the order is stable.
  const sorts = [...(Array.isArray(view.sort) ? view.sort : []), { property: "file.name", direction: "ASC" as const }];
  const keyed = matched.map((entry) => ({
    ...entry,
    keys: sorts.map((sort) => valueOf(propertyId(String(sort.property)), entry.ctx)),
  }));
  keyed.sort((a, b) => {
    for (let i = 0; i < sorts.length; i += 1) {
      const left = a.keys[i]!;
      const right = b.keys[i]!;
      // Empty values go last whatever the direction.
      if (isEmptyValue(left) !== isEmptyValue(right)) return isEmptyValue(left) ? 1 : -1;
      const order = compareValues(left, right) ?? 0;
      if (order !== 0) return sorts[i]!.direction === "DESC" ? -order : order;
    }
    return 0;
  });

  const total = keyed.length;
  const limit = typeof view.limit === "number" && view.limit > 0 ? Math.floor(view.limit) : undefined;
  const shown = limit === undefined ? keyed : keyed.slice(0, limit);

  // Columns: the view's order, plus whatever grouping and the layout need.
  const order = (Array.isArray(view.order) && view.order.length ? view.order : ["file.name"]).map((id) => propertyId(String(id)));
  const extra = [
    view.groupBy?.property,
    typeof view.dateProperty === "string" ? view.dateProperty : undefined,
    typeof view.endDateProperty === "string" ? view.endDateProperty : undefined,
    typeof view.image === "string" ? view.image : undefined,
  ]
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map(propertyId);
  const needed = [...new Set([...order, ...extra])];
  const displayNames = config.properties ?? {};
  const columns: BaseColumn[] = order.map((id) => {
    const key = noteKey(id);
    const displayName = displayNames[id]?.displayName ?? (key !== null ? displayNames[key]?.displayName : undefined);
    return {
      id,
      ...(typeof displayName === "string" ? { displayName } : {}),
      type: key !== null ? (options.types?.get(key) ?? "text") : id.startsWith("formula.") ? "formula" : "file",
      editable: key !== null,
    };
  });

  const rawValues = new Map<string, Value[]>();
  const rows: BaseRow[] = shown.map(({ row, ctx }) => {
    const values: Record<string, BaseValue> = {};
    for (const id of needed) {
      const value = valueOf(id, ctx);
      values[id] = toBaseValue(value);
      let list = rawValues.get(id);
      if (!list) rawValues.set(id, (list = []));
      list.push(value);
    }
    return { id: row.id, kind: row.kind, title: row.title, ...(row.icon ? { icon: row.icon } : {}), updated: row.updated, values };
  });

  // Group.
  let groups: BaseGroup[] | undefined;
  if (view.groupBy?.property) {
    const id = propertyId(view.groupBy.property);
    const byLabel = new Map<string, BaseGroup>();
    rows.forEach((row, index) => {
      const value = row.values[id] ?? null;
      const label = Array.isArray(value) ? value.join(", ") : value === null ? "" : String(value);
      let group = byLabel.get(label);
      if (!group) byLabel.set(label, (group = { value: Array.isArray(value) && !value.length ? null : value, label, rows: [] }));
      group.rows.push(index);
    });
    if (Array.isArray(view.groupOrder)) {
      // Only the listed groups, in that order; `null` is "no value".
      groups = view.groupOrder.map((entry) => {
        const label = entry === null ? "" : String(entry);
        return byLabel.get(label) ?? { value: entry === null ? null : String(entry), label, rows: [] };
      });
    } else {
      groups = [...byLabel.values()].sort((a, b) => {
        if ((a.label === "") !== (b.label === "")) return a.label === "" ? 1 : -1;
        const order = compareValues(a.value as Value, b.value as Value) ?? 0;
        return view.groupBy!.direction === "DESC" ? -order : order;
      });
    }
  }

  // Summaries.
  let summaries: Record<string, string> | undefined;
  if (view.summaries && typeof view.summaries === "object") {
    summaries = {};
    for (const [rawId, name] of Object.entries(view.summaries)) {
      if (typeof name !== "string") continue;
      const id = propertyId(rawId);
      const values = rawValues.get(id) ?? [];
      if (BUILTIN_SUMMARIES.has(name)) {
        summaries[id] = builtinSummary(name, values);
        continue;
      }
      const source = config.summaries && Object.hasOwn(config.summaries, name) ? config.summaries[name] : undefined;
      if (typeof source !== "string") continue;
      const ctx: EvalContext = { file: emptyFile, now, values, thisFile: options.thisFile };
      const value = safely(source, () => evaluateExpression(source, ctx));
      summaries[id] = value === undefined ? "" : valueToString(typeof value === "number" ? Math.round(value * 100) / 100 : value);
    }
  }

  return {
    view: view.name,
    type: view.type,
    columns,
    rows,
    ...(groups ? { groups } : {}),
    ...(summaries ? { summaries } : {}),
    total,
    warnings: [...warnings],
  };
}

/**
 * Frontmatter values → expression values: `date`/`datetime` properties become
 * dates (so `due < today()` and `due.year` work), everything else stays.
 */
export function typedProperties(
  properties: Iterable<[string, unknown]>,
  types?: ReadonlyMap<string, string>,
): Map<string, Value> {
  const props = new Map<string, Value>();
  for (const [key, raw] of properties) {
    const type = types?.get(key);
    props.set(key, toValue(raw, type));
  }
  return props;
}

function toValue(raw: unknown, type?: string): Value {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return { $t: "date", ms: raw.getTime(), time: type === "datetime" };
  if (typeof raw === "string") {
    if (type === "date" || type === "datetime") return parseDate(raw) ?? raw;
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.map((item) => toValue(item));
  // Nested objects aren't Bases values Gumply evaluates.
  return null;
}

const emptyFile: FileInfo = { path: "", title: "", ctime: 0, mtime: 0, tags: [], links: [], props: new Map() };
