/**
 * Obsidian Bases expressions (spec/api-bases, #sg36ng2d): a tokenizer, a
 * parser and an interpreter for the subset Gumply evaluates.
 *
 * Safety: expressions are data, never code. There is no `eval`, no
 * `new Function` and no dynamic property access on JS objects: every field and
 * method is looked up in the explicit tables below, and note properties live
 * in a `Map`, so `constructor`, `__proto__` and friends are just names that
 * don't exist. Expressions see only the indexed row data they are given; they
 * can't read files or reach the network.
 *
 * Anything outside the subset throws `UnsupportedError`. Callers skip that
 * filter (or show "—" for that formula) and report it; the file is never
 * rewritten because of it.
 */

/* ------------------------------------------------------------------ AST */

export type Expr =
  | { type: "literal"; value: string | number | boolean | null }
  | { type: "ident"; name: string }
  | { type: "member"; object: Expr; name: string }
  | { type: "index"; object: Expr; index: Expr }
  | { type: "call"; callee: Expr; args: Expr[] }
  | { type: "unary"; op: "!" | "-"; arg: Expr }
  | { type: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { type: "list"; items: Expr[] };

type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

/** Syntax Gumply can't parse, or a function/field it doesn't implement. */
export class UnsupportedError extends Error {}

/* ------------------------------------------------------------ tokenizer */

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "str"; value: string; pos: number }
  | { kind: "id"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "end"; pos: number };

const OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "."];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i))!;
      tokens.push({ kind: "num", value: Number(match[0]), pos: i });
      i += match[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = "";
      let j = i + 1;
      for (; j < source.length && source[j] !== ch; j += 1) {
        if (source[j] === "\\" && j + 1 < source.length) {
          j += 1;
          const escaped = source[j]!;
          value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        } else {
          value += source[j];
        }
      }
      if (j >= source.length) throw new UnsupportedError(`Unclosed string at ${i}`);
      tokens.push({ kind: "str", value, pos: i });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_$À-￿]/.test(ch)) {
      // As in JavaScript, `a-b` is a subtraction; other names go through `note["my-prop"]`.
      const name = /^[A-Za-z_$À-￿][A-Za-z0-9_$À-￿]*/.exec(source.slice(i))![0];
      tokens.push({ kind: "id", value: name, pos: i });
      i += name.length;
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
    if (!op) throw new UnsupportedError(`Unexpected "${ch}" at ${i}`);
    tokens.push({ kind: "op", value: op, pos: i });
    i += op.length;
  }
  tokens.push({ kind: "end", pos: source.length });
  return tokens;
}

/* --------------------------------------------------------------- parser */

const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const MAX_DEPTH = 64;

export function parseExpression(source: string): Expr {
  const tokens = tokenize(source);
  let at = 0;
  let depth = 0;
  const peek = () => tokens[at]!;
  const isOp = (value: string) => {
    const token = peek();
    return token.kind === "op" && token.value === value;
  };
  const expectOp = (value: string) => {
    if (!isOp(value)) throw new UnsupportedError(`Expected "${value}" at ${peek().pos}`);
    at += 1;
  };

  function binary(minPrec: number): Expr {
    let left = unary();
    for (;;) {
      const token = peek();
      if (token.kind !== "op") break;
      const prec = PRECEDENCE[token.value];
      if (prec === undefined || prec < minPrec) break;
      at += 1;
      const right = binary(prec + 1);
      left = { type: "binary", op: token.value as BinaryOp, left, right };
    }
    return left;
  }

  function unary(): Expr {
    if (isOp("!") || isOp("-")) {
      const op = (peek() as { value: "!" | "-" }).value;
      at += 1;
      return { type: "unary", op, arg: unary() };
    }
    return postfix(primary());
  }

  function args(close: string): Expr[] {
    const list: Expr[] = [];
    if (isOp(close)) {
      at += 1;
      return list;
    }
    for (;;) {
      list.push(expression());
      if (isOp(",")) {
        at += 1;
        continue;
      }
      expectOp(close);
      return list;
    }
  }

  function postfix(node: Expr): Expr {
    for (;;) {
      if (isOp(".")) {
        at += 1;
        const token = peek();
        if (token.kind !== "id") throw new UnsupportedError(`Expected a name at ${token.pos}`);
        at += 1;
        node = { type: "member", object: node, name: token.value };
      } else if (isOp("(")) {
        at += 1;
        node = { type: "call", callee: node, args: args(")") };
      } else if (isOp("[")) {
        at += 1;
        const index = expression();
        expectOp("]");
        node = { type: "index", object: node, index };
      } else {
        return node;
      }
    }
  }

  function primary(): Expr {
    const token = peek();
    at += 1;
    switch (token.kind) {
      case "num":
        return { type: "literal", value: token.value };
      case "str":
        return { type: "literal", value: token.value };
      case "id":
        if (token.value === "true" || token.value === "false") return { type: "literal", value: token.value === "true" };
        if (token.value === "null") return { type: "literal", value: null };
        return { type: "ident", name: token.value };
      case "op":
        if (token.value === "(") {
          const inner = expression();
          expectOp(")");
          return inner;
        }
        if (token.value === "[") return { type: "list", items: args("]") };
        throw new UnsupportedError(`Unexpected "${token.value}" at ${token.pos}`);
      default:
        throw new UnsupportedError("Unexpected end of expression");
    }
  }

  function expression(): Expr {
    depth += 1;
    if (depth > MAX_DEPTH) throw new UnsupportedError("Expression is nested too deeply");
    const node = binary(1);
    depth -= 1;
    return node;
  }

  const result = expression();
  if (peek().kind !== "end") throw new UnsupportedError(`Unexpected text at ${peek().pos}`);
  return result;
}

/* --------------------------------------------------------------- values */

export interface DateValue {
  $t: "date";
  ms: number;
  /** false for a plain `YYYY-MM-DD`. */
  time: boolean;
}
export interface DurationValue {
  $t: "duration";
  ms: number;
}
export interface LinkValue {
  $t: "link";
  /** Link target as written (a title or a path). */
  target: string;
  display?: string;
}
export interface FileValue {
  $t: "file";
  file: FileInfo;
}

export type Value =
  | null
  | boolean
  | number
  | string
  | Value[]
  | DateValue
  | DurationValue
  | LinkValue
  | FileValue
  | NoteValue;

/** A note's properties, keyed safely (a `Map`, so no prototype keys). */
export interface NoteValue {
  $t: "note";
  props: ReadonlyMap<string, Value>;
}

/** What an expression may know about one file (from the server's index). */
export interface FileInfo {
  /** Vault-relative path with extension, e.g. `Projects/Plan.md`. */
  path: string;
  /** Title shown in Gumply. */
  title: string;
  ctime: number;
  mtime: number;
  size?: number;
  tags: readonly string[];
  /** Vault-relative paths (with extension) this file links to. */
  links: readonly string[];
  /** Typed note properties. */
  props: ReadonlyMap<string, Value>;
}

export const isDate = (value: Value): value is DateValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.$t === "date";
const isDuration = (value: Value): value is DurationValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.$t === "duration";
const isLink = (value: Value): value is LinkValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.$t === "link";
const isFile = (value: Value): value is FileValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.$t === "file";
const isNote = (value: Value): value is NoteValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) && value.$t === "note";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** `YYYY-MM-DD` (local midnight) or `YYYY-MM-DDTHH:mm[:ss]` (local) → a date. */
export function parseDate(text: string): DateValue | null {
  const match = DATE_RE.exec(text.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone] = match;
  if (zone) {
    const ms = Date.parse(text.trim());
    return Number.isNaN(ms) ? null : { $t: "date", ms, time: true };
  }
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  if (date.getMonth() !== Number(mo) - 1) return null;
  return { $t: "date", ms: date.getTime(), time: h !== undefined };
}

const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  second: 1000,
  seconds: 1000,
  m: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
  M: -1,
  month: -1,
  months: -1,
  y: -12,
  year: -12,
  years: -12,
};

/** `"1d"`, `"2 weeks"`, `"-3M"`: months and years are calendar steps (negative units). */
function parseDuration(text: string): { ms: number; months: number } | null {
  const match = /^\s*([+-]?\d+(?:\.\d+)?)\s*([A-Za-z]+)\s*$/.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = DURATION_UNITS[match[2]!] ?? DURATION_UNITS[match[2]!.toLowerCase()];
  if (unit === undefined) return null;
  return unit < 0 ? { ms: 0, months: -unit * amount } : { ms: unit * amount, months: 0 };
}

function shiftDate(date: DateValue, text: string, sign: 1 | -1): DateValue {
  const duration = parseDuration(text);
  if (!duration) throw new EvalError(`Not a duration: ${text}`);
  const shifted = new Date(date.ms);
  if (duration.months) shifted.setMonth(shifted.getMonth() + sign * duration.months);
  return { $t: "date", ms: shifted.getTime() + sign * duration.ms, time: date.time };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (the forms Obsidian writes). */
export function formatDate(date: DateValue): string {
  const d = new Date(date.ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return date.time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

/** A moment.js-style format, the tokens Obsidian users write. */
function formatPattern(date: DateValue, pattern: string): string {
  const d = new Date(date.ms);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => months[d.getMonth()]!,
    MMM: () => months[d.getMonth()]!.slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => days[d.getDay()]!,
    ddd: () => days[d.getDay()]!.slice(0, 3),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(d.getHours() % 12 || 12),
    h: () => String(d.getHours() % 12 || 12),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    A: () => (d.getHours() < 12 ? "AM" : "PM"),
    a: () => (d.getHours() < 12 ? "am" : "pm"),
  };
  return pattern.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (token, literal?: string) =>
    literal !== undefined ? literal : tokens[token]!(),
  );
}

/** A failed evaluation of a supported expression (e.g. a method on null): the value is null. */
class EvalError extends Error {}

/* ---------------------------------------------------------- interpreter */

export interface EvalContext {
  file: FileInfo;
  /** The base file, or the page it's embedded in (`this`). */
  thisFile?: FileInfo;
  /** `formula.<name>` → its value for this row. */
  formula?: (name: string) => Value;
  /** Summary formulas: the column's values. */
  values?: Value[];
  /** Current time, for `now()` / `today()` (tests pin it). */
  now: number;
  /** Resolve a link target (title or path) to a vault path, if it exists. */
  resolveLink?: (target: string) => string | null;
}

interface Scope {
  ctx: EvalContext;
  locals?: ReadonlyMap<string, Value>;
}

function truthy(value: Value): boolean {
  if (value === null || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isEmpty(value: Value): boolean {
  if (value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isNote(value)) return value.props.size === 0;
  return false;
}

/** The text a value shows as. */
export function valueToString(value: Value): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(valueToString).join(", ");
  switch (value.$t) {
    case "date":
      return formatDate(value);
    case "duration":
      return `${value.ms}ms`;
    case "link":
      return value.display ?? value.target;
    case "file":
      return value.file.title;
    case "note":
      return "";
  }
}

function asDate(value: Value): DateValue | null {
  if (isDate(value)) return value;
  if (typeof value === "string") return parseDate(value);
  return null;
}

/** Strip `[[…]]`, `|alias`, `#heading` and `.md` for link comparisons. */
function linkKey(text: string): string {
  let target = text.trim();
  const wiki = /^\[\[([^\]]*)\]\]$/.exec(target);
  if (wiki) target = wiki[1]!;
  target = target.split("|")[0]!.split("#")[0]!.trim();
  return target.replace(/\.md$/i, "").toLowerCase();
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function compare(left: Value, right: Value): number | null {
  if (left === null || right === null) return null;
  const leftDate = isDate(left) ? left : isDate(right) ? asDate(left) : null;
  const rightDate = isDate(right) ? right : isDate(left) ? asDate(right) : null;
  if (leftDate && rightDate) return leftDate.ms - rightDate.ms;
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "number" && typeof right === "string" && right.trim() !== "" && !Number.isNaN(Number(right)))
    return left - Number(right);
  if (typeof left === "string" && typeof right === "number" && left.trim() !== "" && !Number.isNaN(Number(left)))
    return Number(left) - right;
  return valueToString(left).localeCompare(valueToString(right), undefined, { numeric: true, sensitivity: "base" });
}

function equals(left: Value, right: Value): boolean {
  if (left === null || right === null) return isEmpty(left) && isEmpty(right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, i) => equals(item, right[i]!));
  }
  if (isLink(left) || isLink(right) || isFile(left) || isFile(right)) return linkTarget(left) === linkTarget(right);
  if (typeof left === "boolean" || typeof right === "boolean") return left === right;
  const order = compare(left, right);
  if (order === null) return false;
  if (typeof left === "string" && typeof right === "string") return left === right;
  return order === 0;
}

function linkTarget(value: Value): string {
  if (isFile(value)) return linkKey(value.file.path);
  if (isLink(value)) return linkKey(value.target);
  return linkKey(valueToString(value));
}

function fileField(file: FileInfo, name: string): Value {
  const slash = file.path.lastIndexOf("/");
  const fileName = baseName(file.path);
  const dot = fileName.lastIndexOf(".");
  switch (name) {
    case "name":
      return fileName;
    case "basename":
      return dot > 0 ? fileName.slice(0, dot) : fileName;
    case "path":
      return file.path;
    case "folder":
      return slash < 0 ? "" : file.path.slice(0, slash);
    case "ext":
      return dot > 0 ? fileName.slice(dot + 1) : "";
    case "ctime":
      return { $t: "date", ms: file.ctime, time: true };
    case "mtime":
      return { $t: "date", ms: file.mtime, time: true };
    case "size":
      if (file.size === undefined) throw new UnsupportedError("file.size");
      return file.size;
    case "tags":
      return [...file.tags];
    case "links":
      return file.links.map((path) => ({ $t: "link", target: path }) as LinkValue);
    case "properties":
      return { $t: "note", props: file.props };
    case "file":
      return { $t: "file", file };
    default:
      throw new UnsupportedError(`file.${name}`);
  }
}

function hasTag(file: FileInfo, wanted: string): boolean {
  const tag = wanted.replace(/^#/, "").toLowerCase();
  return file.tags.some((own) => {
    const lower = own.replace(/^#/, "").toLowerCase();
    return lower === tag || lower.startsWith(`${tag}/`);
  });
}

function inFolder(file: FileInfo, folder: string): boolean {
  const wanted = folder.replace(/^\/+|\/+$/g, "");
  if (wanted === "") return true;
  return file.path.toLowerCase().startsWith(`${wanted.toLowerCase()}/`);
}

function fileMethod(scope: Scope, file: FileInfo, name: string, args: Value[]): Value {
  switch (name) {
    case "hasTag":
      return args.some((arg) => hasTag(file, valueToString(arg)));
    case "inFolder":
      return inFolder(file, valueToString(args[0] ?? ""));
    case "hasProperty":
      return file.props.has(valueToString(args[0] ?? ""));
    case "hasLink": {
      const arg = args[0] ?? null;
      let wanted = isFile(arg) ? arg.file.path : isLink(arg) ? arg.target : valueToString(arg);
      wanted = scope.ctx.resolveLink?.(wanted) ?? wanted;
      const key = linkKey(wanted);
      const keyBase = baseName(key);
      return file.links.some((path) => {
        const own = linkKey(path);
        return own === key || (!key.includes("/") && baseName(own) === keyBase);
      });
    }
    case "asLink":
      return { $t: "link", target: file.path, display: args[0] === undefined ? file.title : valueToString(args[0]) };
    default:
      throw new UnsupportedError(`file.${name}()`);
  }
}

function toNumber(value: Value): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  if (isDate(value)) return value.ms;
  throw new EvalError("Not a number");
}

function arithmetic(op: BinaryOp, left: Value, right: Value): Value {
  if (left === null || right === null) return null;
  if (op === "+" || op === "-") {
    const date = asDateStrict(left);
    if (date && (typeof right === "string" || isDuration(right))) {
      if (isDuration(right)) return { $t: "date", ms: date.ms + (op === "+" ? right.ms : -right.ms), time: date.time };
      const rightDate = op === "-" ? parseDate(right) : null;
      if (rightDate) return date.ms - rightDate.ms;
      return shiftDate(date, right, op === "+" ? 1 : -1);
    }
    if (op === "-" && date) {
      const other = asDate(right);
      if (other) return date.ms - other.ms;
    }
    if (op === "+" && (typeof left === "string" || typeof right === "string") && !(typeof left === "number" && typeof right === "number"))
      return valueToString(left) + valueToString(right);
  }
  const a = toNumber(left);
  const b = toNumber(right);
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return b === 0 ? null : a / b;
    case "%":
      return b === 0 ? null : a % b;
    default:
      throw new UnsupportedError(op);
  }
}

/** Only real date values (not date-looking strings) start date arithmetic. */
function asDateStrict(value: Value): DateValue | null {
  return isDate(value) ? value : null;
}

function evaluateNode(node: Expr, scope: Scope): Value {
  switch (node.type) {
    case "literal":
      return node.value;
    case "list":
      return node.items.map((item) => evaluateNode(item, scope));
    case "ident":
      return identifier(node.name, scope);
    case "unary": {
      const value = evaluateNode(node.arg, scope);
      if (node.op === "!") return !truthy(value);
      return value === null ? null : -toNumber(value);
    }
    case "binary": {
      if (node.op === "&&") return truthy(evaluateNode(node.left, scope)) && truthy(evaluateNode(node.right, scope));
      if (node.op === "||") {
        const left = evaluateNode(node.left, scope);
        return truthy(left) ? left : evaluateNode(node.right, scope);
      }
      const left = evaluateNode(node.left, scope);
      const right = evaluateNode(node.right, scope);
      switch (node.op) {
        case "==":
          return equals(left, right);
        case "!=":
          return !equals(left, right);
        case "<":
        case "<=":
        case ">":
        case ">=": {
          const order = compare(left, right);
          if (order === null) return false;
          return node.op === "<" ? order < 0 : node.op === "<=" ? order <= 0 : node.op === ">" ? order > 0 : order >= 0;
        }
        default:
          return arithmetic(node.op, left, right);
      }
    }
    case "member":
      return member(node, scope);
    case "index": {
      const object = evaluateNode(node.object, scope);
      const index = evaluateNode(node.index, scope);
      if (Array.isArray(object)) {
        const i = toNumber(index);
        return object[i < 0 ? object.length + i : i] ?? null;
      }
      if (isNote(object)) return object.props.get(valueToString(index)) ?? null;
      if (isFile(object)) return object.file.props.get(valueToString(index)) ?? null;
      if (object === null) return null;
      throw new UnsupportedError("Indexing this value");
    }
    case "call":
      return call(node, scope);
  }
}

function identifier(name: string, scope: Scope): Value {
  const local = scope.locals?.get(name);
  if (local !== undefined || scope.locals?.has(name)) return local ?? null;
  const { ctx } = scope;
  switch (name) {
    case "file":
      return { $t: "file", file: ctx.file };
    case "note":
      return { $t: "note", props: ctx.file.props };
    case "this":
      if (!ctx.thisFile) return null;
      return { $t: "file", file: ctx.thisFile };
    case "values":
      if (!ctx.values) throw new UnsupportedError("values outside a summary");
      return ctx.values;
    case "formula":
      throw new UnsupportedError("formula without a name");
    default:
      // A bare name is a note property (`status` = `note.status`).
      return ctx.file.props.get(name) ?? null;
  }
}

function member(node: Extract<Expr, { type: "member" }>, scope: Scope): Value {
  // `formula.x` and `this.file` are names, not values.
  if (node.object.type === "ident" && node.object.name === "formula" && !scope.locals?.has("formula")) {
    if (!scope.ctx.formula) throw new UnsupportedError("formula");
    return scope.ctx.formula(node.name);
  }
  const object = evaluateNode(node.object, scope);
  return field(object, node.name, node.object.type === "ident" ? node.object.name : null);
}

function field(object: Value, name: string, objectName: string | null): Value {
  if (object === null) return null;
  if (isFile(object)) {
    // `file.x` is a file field; `this.x` reaches both the file (`this.file`) and its properties.
    if (objectName === "this" && name !== "file") return object.file.props.get(name) ?? null;
    if (objectName === "this" || (objectName !== "file" && name === "file")) return object;
    return fileField(object.file, name);
  }
  if (isNote(object)) return object.props.get(name) ?? null;
  if (isDate(object)) {
    const d = new Date(object.ms);
    switch (name) {
      case "year":
        return d.getFullYear();
      case "month":
        return d.getMonth() + 1;
      case "day":
        return d.getDate();
      case "hour":
        return d.getHours();
      case "minute":
        return d.getMinutes();
      case "second":
        return d.getSeconds();
      case "millisecond":
        return d.getMilliseconds();
      default:
        throw new UnsupportedError(`date.${name}`);
    }
  }
  if (name === "length" && (typeof object === "string" || Array.isArray(object))) return object.length;
  throw new UnsupportedError(`.${name}`);
}

const GLOBALS = new Set(["date", "today", "now", "duration", "if", "list", "number", "link", "min", "max", "choice"]);

function call(node: Extract<Expr, { type: "call" }>, scope: Scope): Value {
  const { callee } = node;
  if (callee.type === "ident") {
    if (!GLOBALS.has(callee.name)) throw new UnsupportedError(`${callee.name}()`);
    return globalCall(callee.name, node.args, scope);
  }
  if (callee.type !== "member") throw new UnsupportedError("Calling this value");
  const name = callee.name;

  // List methods that take an expression run it per item (`value`, `index`).
  const object = evaluateNode(callee.object, scope);
  if (Array.isArray(object) && (name === "filter" || name === "map" || name === "reduce")) {
    return listLambda(object, name, node.args, scope);
  }
  const args = node.args.map((arg) => evaluateNode(arg, scope));
  if (isFile(object) && !(callee.object.type === "ident" && callee.object.name === "this" && name !== "file")) {
    return fileMethod(scope, object.file, name, args);
  }
  return method(object, name, args);
}

function listLambda(list: Value[], name: "filter" | "map" | "reduce", argNodes: Expr[], scope: Scope): Value {
  const body = argNodes[0];
  if (!body) throw new EvalError(`${name}() needs an expression`);
  if (name === "reduce") {
    let acc: Value = argNodes[1] ? evaluateNode(argNodes[1], scope) : null;
    list.forEach((value, index) => {
      acc = evaluateNode(body, { ctx: scope.ctx, locals: withLocals(scope, { value, index, acc }) });
    });
    return acc;
  }
  const results = list.map((value, index) => evaluateNode(body, { ctx: scope.ctx, locals: withLocals(scope, { value, index }) }));
  return name === "map" ? results : list.filter((_, i) => truthy(results[i]!));
}

function withLocals(scope: Scope, extra: Record<string, Value>): Map<string, Value> {
  const locals = new Map(scope.locals ?? []);
  for (const [key, value] of Object.entries(extra)) locals.set(key, value);
  return locals;
}

function globalCall(name: string, argNodes: Expr[], scope: Scope): Value {
  if (name === "if") {
    const condition = truthy(evaluateNode(argNodes[0] ?? { type: "literal", value: null }, scope));
    const branch = condition ? argNodes[1] : argNodes[2];
    return branch ? evaluateNode(branch, scope) : null;
  }
  const args = argNodes.map((arg) => evaluateNode(arg, scope));
  const first = args[0] ?? null;
  switch (name) {
    case "now":
      return { $t: "date", ms: scope.ctx.now, time: true };
    case "today": {
      const d = new Date(scope.ctx.now);
      return { $t: "date", ms: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), time: false };
    }
    case "date":
      return asDate(first);
    case "duration": {
      const parsed = parseDuration(valueToString(first));
      if (!parsed) return null;
      if (parsed.months) throw new UnsupportedError("duration() in months");
      return { $t: "duration", ms: parsed.ms };
    }
    case "list":
      return Array.isArray(first) ? first : first === null ? [] : [first];
    case "number":
      try {
        return toNumber(first);
      } catch {
        return null;
      }
    case "link":
      return { $t: "link", target: valueToString(first), display: args[1] === undefined ? undefined : valueToString(args[1]) };
    case "min":
    case "max": {
      const numbers = args.flat().filter((value) => value !== null).map(toNumber);
      if (!numbers.length) return null;
      return name === "min" ? Math.min(...numbers) : Math.max(...numbers);
    }
    default:
      throw new UnsupportedError(`${name}()`);
  }
}

function method(object: Value, name: string, args: Value[]): Value {
  // Methods on any value.
  switch (name) {
    case "isEmpty":
      return isEmpty(object);
    case "isTruthy":
      return truthy(object);
    case "toString":
      return valueToString(object);
    case "isType": {
      const wanted = valueToString(args[0] ?? "");
      return typeOf(object) === wanted;
    }
  }
  if (object === null) return null;
  if (typeof object === "string") return stringMethod(object, name, args);
  if (typeof object === "number") return numberMethod(object, name, args);
  if (Array.isArray(object)) return listMethod(object, name, args);
  if (isDate(object)) return dateMethod(object, name, args);
  if (isLink(object) && name === "linksTo") return linkKey(object.target) === linkTarget(args[0] ?? null);
  throw new UnsupportedError(`.${name}()`);
}

function typeOf(value: Value): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return value.$t === "note" ? "object" : value.$t;
  return typeof value;
}

function stringMethod(text: string, name: string, args: Value[]): Value {
  const arg = (i: number) => valueToString(args[i] ?? null);
  switch (name) {
    case "contains":
      return text.includes(arg(0));
    case "containsAll":
      return args.every((value) => text.includes(valueToString(value)));
    case "containsAny":
      return args.some((value) => text.includes(valueToString(value)));
    case "startsWith":
      return text.startsWith(arg(0));
    case "endsWith":
      return text.endsWith(arg(0));
    case "lower":
      return text.toLowerCase();
    case "upper":
      return text.toUpperCase();
    case "title":
      return text.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
    case "trim":
      return text.trim();
    case "replace":
      return text.split(arg(0)).join(arg(1));
    case "split":
      return text.split(arg(0));
    case "slice":
      return text.slice(args[0] === undefined ? 0 : toNumber(args[0]), args[1] === undefined ? undefined : toNumber(args[1]));
    case "reverse":
      return [...text].reverse().join("");
    case "repeat":
      return text.repeat(Math.max(0, Math.min(1000, toNumber(args[0] ?? 0))));
    default: {
      // A date-looking string answers date methods (`due.format("D MMM")`).
      const date = parseDate(text);
      if (date) return dateMethod(date, name, args);
      throw new UnsupportedError(`string.${name}()`);
    }
  }
}

function numberMethod(value: number, name: string, args: Value[]): Value {
  switch (name) {
    case "abs":
      return Math.abs(value);
    case "ceil":
      return Math.ceil(value);
    case "floor":
      return Math.floor(value);
    case "round": {
      const digits = args[0] === undefined ? 0 : Math.max(0, Math.min(15, toNumber(args[0])));
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    }
    case "toFixed":
      return value.toFixed(Math.max(0, Math.min(20, toNumber(args[0] ?? 0))));
    default:
      throw new UnsupportedError(`number.${name}()`);
  }
}

function listMethod(list: Value[], name: string, args: Value[]): Value {
  switch (name) {
    case "contains":
      return list.some((item) => equals(item, args[0] ?? null));
    case "containsAll":
      return args.every((wanted) => list.some((item) => equals(item, wanted)));
    case "containsAny":
      return args.some((wanted) => list.some((item) => equals(item, wanted)));
    case "join":
      return list.map(valueToString).join(args[0] === undefined ? ", " : valueToString(args[0]));
    case "unique": {
      const seen: Value[] = [];
      for (const item of list) if (!seen.some((other) => equals(other, item))) seen.push(item);
      return seen;
    }
    case "sort":
      return [...list].sort((a, b) => compare(a, b) ?? 0);
    case "reverse":
      return [...list].reverse();
    case "flat":
      return list.flat();
    case "slice":
      return list.slice(args[0] === undefined ? 0 : toNumber(args[0]), args[1] === undefined ? undefined : toNumber(args[1]));
    default:
      throw new UnsupportedError(`list.${name}()`);
  }
}

function dateMethod(date: DateValue, name: string, args: Value[]): Value {
  switch (name) {
    case "format":
      return formatPattern(date, valueToString(args[0] ?? "YYYY-MM-DD"));
    case "date": {
      const d = new Date(date.ms);
      return { $t: "date", ms: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), time: false };
    }
    case "time":
      return formatPattern(date, "HH:mm:ss");
    default:
      throw new UnsupportedError(`date.${name}()`);
  }
}

/* ------------------------------------------------------------ public API */

const cache = new Map<string, Expr | UnsupportedError>();

/** Parse once per distinct source text (bases re-run the same filters per row). */
export function compileExpression(source: string): Expr {
  const cached = cache.get(source);
  if (cached instanceof UnsupportedError) throw cached;
  if (cached) return cached;
  try {
    const parsed = parseExpression(source);
    if (cache.size > 2000) cache.clear();
    cache.set(source, parsed);
    return parsed;
  } catch (error) {
    const unsupported = error instanceof UnsupportedError ? error : new UnsupportedError(String(error));
    cache.set(source, unsupported);
    throw unsupported;
  }
}

/**
 * Evaluate `source` for one row. `UnsupportedError` propagates (the caller
 * skips the expression and reports it); any other failure is `null`.
 */
export function evaluateExpression(source: string | Expr, ctx: EvalContext): Value {
  const node = typeof source === "string" ? compileExpression(source) : source;
  try {
    return evaluateNode(node, { ctx });
  } catch (error) {
    if (error instanceof UnsupportedError) throw error;
    if (error instanceof EvalError || error instanceof RangeError || error instanceof TypeError) return null;
    throw error;
  }
}

export { compare as compareValues, equals as valuesEqual, truthy as isTruthy, isEmpty as isEmptyValue };
