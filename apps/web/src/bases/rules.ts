/**
 * The filter builder's rules ↔ Bases expressions (spec/api-bases).
 *
 * Every rule the builder makes is one plain Obsidian expression in the view's
 * `filters.and` list (`status == "Done"`, `due < date("2026-12-01")`,
 * `tags.contains("work")`), so Obsidian reads it as written. Expressions the
 * builder can't show as a rule stay as text: shown, kept, never rewritten.
 */
import type { BaseConfig, BaseFilter, BaseView } from "@gumply/core";

export type RuleOp =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "empty"
  | "notEmpty"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "before"
  | "after"
  | "checked"
  | "unchecked";

export interface FilterRule {
  /** `note.status`, `file.name`, `formula.x`. */
  property: string;
  op: RuleOp;
  value: string;
}

/** A clause of a view's filter: a rule the builder edits, or an expression it keeps. */
export type FilterClause = { rule: FilterRule } | { raw: BaseFilter };

const RESERVED = new Set(["file", "note", "formula", "this", "values", "true", "false", "null", "if", "date", "today", "now"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How an expression names a property: `status`, `note["due date"]`, `file.name`. */
export function propertyRef(id: string): string {
  if (id.startsWith("file.") || id.startsWith("formula.")) return id;
  const key = id.startsWith("note.") ? id.slice(5) : id;
  if (IDENTIFIER.test(key) && !RESERVED.has(key)) return key;
  return `note[${JSON.stringify(key)}]`;
}

/** The operators that make sense for a property type (v1.12 type names). */
export function opsFor(type: string): RuleOp[] {
  switch (type) {
    case "number":
      return ["is", "isNot", "lt", "lte", "gt", "gte", "empty", "notEmpty"];
    case "date":
    case "datetime":
      return ["is", "before", "after", "empty", "notEmpty"];
    case "checkbox":
      return ["checked", "unchecked"];
    case "multitext":
    case "tags":
    case "aliases":
      return ["contains", "notContains", "empty", "notEmpty"];
    default:
      return ["is", "isNot", "contains", "notContains", "empty", "notEmpty"];
  }
}

/** Operators that take no value. */
export function opTakesValue(op: RuleOp): boolean {
  return !["empty", "notEmpty", "checked", "unchecked"].includes(op);
}

function literal(value: string, type: string, op: RuleOp): string {
  if (type === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return String(Number(value));
  if ((type === "date" || type === "datetime") && op !== "contains" && op !== "notContains") {
    return `date(${JSON.stringify(value)})`;
  }
  return JSON.stringify(value);
}

/** One rule as the expression Obsidian reads. */
export function ruleToExpression(rule: FilterRule, type: string): string {
  const ref = propertyRef(rule.property);
  const value = literal(rule.value, type, rule.op);
  switch (rule.op) {
    case "is":
      return `${ref} == ${value}`;
    case "isNot":
      return `${ref} != ${value}`;
    case "contains":
      return `${ref}.contains(${JSON.stringify(rule.value)})`;
    case "notContains":
      return `!${ref}.contains(${JSON.stringify(rule.value)})`;
    case "empty":
      return `${ref}.isEmpty()`;
    case "notEmpty":
      return `!${ref}.isEmpty()`;
    case "lt":
    case "before":
      return `${ref} < ${value}`;
    case "lte":
      return `${ref} <= ${value}`;
    case "gt":
    case "after":
      return `${ref} > ${value}`;
    case "gte":
      return `${ref} >= ${value}`;
    case "checked":
      return `${ref} == true`;
    case "unchecked":
      return `${ref} != true`;
  }
}

const REF = String.raw`((?:file|formula|note)\.[A-Za-z_][A-Za-z0-9_]*|note\["(?:[^"\\]|\\.)*"\]|[A-Za-z_][A-Za-z0-9_]*)`;
const STRING = String.raw`"((?:[^"\\]|\\.)*)"`;
const VALUE = String.raw`(${STRING}|date\(${STRING}\)|-?\d+(?:\.\d+)?|true|false)`;

const COMPARE = new RegExp(String.raw`^${REF}\s*(==|!=|<=|>=|<|>)\s*${VALUE}$`);
const CONTAINS = new RegExp(String.raw`^(!?)${REF}\.contains\(${STRING}\)$`);
const EMPTY = new RegExp(String.raw`^(!?)${REF}\.isEmpty\(\)$`);

function refToId(ref: string): string | null {
  if (ref.startsWith("note[")) {
    try {
      return `note.${JSON.parse(ref.slice(5, -1)) as string}`;
    } catch {
      return null;
    }
  }
  if (ref.startsWith("file.") || ref.startsWith("formula.") || ref.startsWith("note.")) return ref;
  if (RESERVED.has(ref)) return null;
  return `note.${ref}`;
}

function unquote(text: string): string {
  return JSON.parse(`"${text}"`) as string;
}

/** An expression the builder can show as a rule, else null (kept as text). */
export function parseRule(expression: string): FilterRule | null {
  const text = expression.trim();
  let match = COMPARE.exec(text);
  if (match) {
    const property = refToId(match[1]!);
    if (!property) return null;
    const operator = match[2]!;
    const [, , , whole, plain, dated] = match;
    const isDate = dated !== undefined;
    const value = plain !== undefined ? unquote(plain) : isDate ? unquote(dated) : whole!;
    if (whole === "true" || whole === "false") {
      if (operator === "==" && whole === "true") return { property, op: "checked", value: "" };
      if ((operator === "!=" && whole === "true") || (operator === "==" && whole === "false")) {
        return { property, op: "unchecked", value: "" };
      }
      return null;
    }
    const op: RuleOp | undefined = {
      "==": "is",
      "!=": "isNot",
      "<": isDate ? "before" : "lt",
      "<=": isDate ? undefined : "lte",
      ">": isDate ? "after" : "gt",
      ">=": isDate ? undefined : "gte",
    }[operator] as RuleOp | undefined;
    return op ? { property, op, value } : null;
  }
  match = CONTAINS.exec(text);
  if (match) {
    const property = refToId(match[2]!);
    return property ? { property, op: match[1] ? "notContains" : "contains", value: unquote(match[3]!) } : null;
  }
  match = EMPTY.exec(text);
  if (match) {
    const property = refToId(match[2]!);
    return property ? { property, op: match[1] ? "notEmpty" : "empty", value: "" } : null;
  }
  return null;
}

/**
 * A view's filter as builder clauses. Only `undefined`, a single string or an
 * `and` list are a list of clauses; anything else (`or`, `not` at the top) is
 * one clause the builder keeps as it is.
 */
export function viewClauses(view: BaseView): FilterClause[] {
  const filter = view.filters;
  if (filter === undefined) return [];
  const list = typeof filter === "string" ? [filter] : "and" in filter ? filter.and : [filter];
  return list.map((item) => {
    const rule = typeof item === "string" ? parseRule(item) : null;
    return rule ? { rule } : { raw: item };
  });
}

/** The view with its filter set from builder clauses (no clauses: no filter). */
export function withClauses(view: BaseView, clauses: FilterClause[], typeOf: (id: string) => string): BaseView {
  const next: BaseView = { ...view };
  const list: BaseFilter[] = clauses.map((clause) =>
    "rule" in clause ? ruleToExpression(clause.rule, typeOf(clause.rule.property)) : clause.raw,
  );
  if (list.length === 0) delete next.filters;
  else next.filters = { and: list };
  return next;
}

export type BaseSource = { kind: "all" } | { kind: "folder"; folder: string } | { kind: "tag"; tag: string };

const IN_FOLDER = /^file\.inFolder\(\s*"((?:[^"\\]|\\.)*)"\s*\)$/;
const HAS_TAG = /^file\.hasTag\(\s*"((?:[^"\\]|\\.)*)"\s*\)$/;

function sourceClause(item: BaseFilter): BaseSource | null {
  if (typeof item !== "string") return null;
  const folder = IN_FOLDER.exec(item.trim());
  if (folder) return { kind: "folder", folder: unquote(folder[1]!) };
  const tag = HAS_TAG.exec(item.trim());
  if (tag) return { kind: "tag", tag: unquote(tag[1]!) };
  return null;
}

/** Where a base's pages come from: the first folder or tag clause of its global filter. */
export function baseSource(config: BaseConfig): BaseSource {
  const filter = config.filters;
  if (filter === undefined) return { kind: "all" };
  const list = typeof filter === "string" ? [filter] : "and" in filter ? filter.and : [];
  for (const item of list) {
    const source = sourceClause(item);
    if (source) return source;
  }
  return { kind: "all" };
}

/** True when the global filter has more than the source (shown as "and more filters"). */
export function hasOtherGlobalFilters(config: BaseConfig): boolean {
  const filter = config.filters;
  if (filter === undefined) return false;
  if (typeof filter === "string") return sourceClause(filter) === null;
  if (!("and" in filter)) return true;
  return filter.and.some((item) => sourceClause(item) === null);
}

/** The config with its source replaced; other global clauses are kept in place. */
export function withSource(config: BaseConfig, source: BaseSource): BaseConfig {
  const clause =
    source.kind === "folder"
      ? `file.inFolder(${JSON.stringify(source.folder)})`
      : source.kind === "tag"
        ? `file.hasTag(${JSON.stringify(source.tag.replace(/^#/, ""))})`
        : null;
  const filter = config.filters;
  let list: BaseFilter[];
  let wrapped = false;
  if (filter === undefined) list = [];
  else if (typeof filter === "string") list = [filter];
  else if ("and" in filter) {
    list = [...filter.and];
    wrapped = true;
  } else list = [filter];
  const at = list.findIndex((item) => sourceClause(item) !== null);
  if (at >= 0) {
    if (clause) list[at] = clause;
    else list.splice(at, 1);
  } else if (clause) {
    list.unshift(clause);
  }
  const next: BaseConfig = { ...config };
  if (list.length === 0) delete next.filters;
  else if (list.length === 1 && !wrapped && typeof list[0] === "string") next.filters = { and: list };
  else next.filters = { and: list };
  return next;
}
