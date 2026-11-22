/**
 * Minimal `.canvas` writes (#3c86ify2, D37): change a board file only where
 * the board changed, keeping the file's own layout (tabs or spaces, one line
 * or many, CRLF, a final newline, `\u` escapes) everywhere else.
 *
 * `serializeCanvas` writes Obsidian's layout, which is right for the editor's
 * own saves, but a link rewrite after a rename, a folder move or an MCP
 * `add_to_board` must not reformat a file someone else wrote. These callers
 * pass the board as read and as wanted; `patchCanvasFile` returns the file
 * with only the changed string values replaced and new nodes appended, or
 * `null` when the change is anything else (the caller then writes the whole
 * file as before).
 */
import type { CanvasBoard } from "./canvas.js";

/** A JSON value's place in the file: `[start, end)` offsets. */
interface Span {
  start: number;
  end: number;
}

interface ObjectSpans extends Span {
  /** Each key's value span, in file order. */
  values: Map<string, Span>;
}

interface ArraySpans extends Span {
  items: Span[];
}

/** Thrown inside the scanner for anything that isn't the JSON we expect. */
class NotJson extends Error {}

const WS = /[ \t\r\n]/;

/** A tiny JSON scanner that records where things are (it never rebuilds text). */
class Scanner {
  constructor(private readonly text: string) {}

  skip(at: number): number {
    while (at < this.text.length && WS.test(this.text[at]!)) at += 1;
    return at;
  }

  string(at: number): number {
    if (this.text[at] !== '"') throw new NotJson();
    at += 1;
    while (at < this.text.length) {
      const char = this.text[at]!;
      if (char === "\\") at += 2;
      else if (char === '"') return at + 1;
      else at += 1;
    }
    throw new NotJson();
  }

  /** The end of the value starting at `at` (whitespace already skipped). */
  value(at: number): number {
    const char = this.text[at];
    if (char === '"') return this.string(at);
    if (char === "{") return this.object(at).end;
    if (char === "[") return this.array(at).end;
    const match = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.text.slice(at, at + 64));
    if (!match) throw new NotJson();
    return at + match[0].length;
  }

  object(at: number): ObjectSpans {
    const start = at;
    if (this.text[at] !== "{") throw new NotJson();
    const values = new Map<string, Span>();
    at = this.skip(at + 1);
    if (this.text[at] === "}") return { start, end: at + 1, values };
    for (;;) {
      const keyEnd = this.string(at);
      const key = JSON.parse(this.text.slice(at, keyEnd)) as string;
      at = this.skip(keyEnd);
      if (this.text[at] !== ":") throw new NotJson();
      const valueStart = this.skip(at + 1);
      const valueEnd = this.value(valueStart);
      // A repeated key: JSON.parse keeps the last one, so do we.
      values.set(key, { start: valueStart, end: valueEnd });
      at = this.skip(valueEnd);
      if (this.text[at] === ",") {
        at = this.skip(at + 1);
        continue;
      }
      if (this.text[at] === "}") return { start, end: at + 1, values };
      throw new NotJson();
    }
  }

  array(at: number): ArraySpans {
    const start = at;
    if (this.text[at] !== "[") throw new NotJson();
    const items: Span[] = [];
    at = this.skip(at + 1);
    if (this.text[at] === "]") return { start, end: at + 1, items };
    for (;;) {
      const itemEnd = this.value(at);
      items.push({ start: at, end: itemEnd });
      at = this.skip(itemEnd);
      if (this.text[at] === ",") {
        at = this.skip(at + 1);
        continue;
      }
      if (this.text[at] === "]") return { start, end: at + 1, items };
      throw new NotJson();
    }
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => sameJson(item, other[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  return keys.length === otherKeys.length && keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

/** The board as plain JSON (drops `undefined`, like a write would). */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

/** The file's line ending and the indent of one level ("\t", "  "…), from its own text. */
function layoutOf(raw: string): { eol: string; unit: string } {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const indents = [...raw.matchAll(/\n([ \t]+)\S/g)].map((match) => match[1]!);
  if (indents.length === 0) return { eol, unit: "\t" };
  const shortest = indents.reduce((a, b) => (b.length < a.length ? b : a));
  return { eol, unit: shortest };
}

/** A value laid out like Obsidian's writer (one line when it holds only primitives), in `unit`s. */
function layoutValue(value: unknown, unit: string, eol: string, depth: number): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  const pad = (n: number) => unit.repeat(n);
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== "object" || item === null)) return JSON.stringify(value);
    const items = value.map((item) => `${pad(depth + 1)}${layoutValue(item, unit, eol, depth + 1)}`);
    return `[${eol}${items.join(`,${eol}`)}${eol}${pad(depth)}]`;
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined);
  if (keys.every((key) => typeof object[key] !== "object" || object[key] === null)) return JSON.stringify(object);
  const entries = keys.map((key) => `${pad(depth + 1)}${JSON.stringify(key)}:${layoutValue(object[key], unit, eol, depth + 1)}`);
  return `{${eol}${entries.join(`,${eol}`)}${eol}${pad(depth)}}`;
}

/**
 * `raw` with `before` turned into `after`, touching nothing else; `null` when
 * that isn't a minimal change. Minimal means: the top level and the edges are
 * unchanged; each existing node keeps its id, place and keys and changes only
 * string values; new nodes (if any) are appended after the last one.
 */
export function patchCanvasFile(raw: string, before: CanvasBoard, after: CanvasBoard): string | null {
  const was = plain(before) as Record<string, unknown>;
  const now = plain(after) as Record<string, unknown>;
  // The file must be the board we think it is (an outside edit, a repaired file → no patch).
  const bom = raw.startsWith("﻿") ? 1 : 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(bom));
  } catch {
    return null;
  }
  if (!sameJson(parsed, was)) return null;

  const topKeys = new Set([...Object.keys(was), ...Object.keys(now)]);
  for (const key of topKeys) if (key !== "nodes" && !sameJson(was[key], now[key])) return null;
  const oldNodes = (Array.isArray(was.nodes) ? was.nodes : []) as Array<Record<string, unknown>>;
  const newNodes = (Array.isArray(now.nodes) ? now.nodes : []) as Array<Record<string, unknown>>;
  if (newNodes.length < oldNodes.length) return null;

  let scan: { root: ObjectSpans; nodes: ArraySpans | null; objects: ObjectSpans[] };
  try {
    const scanner = new Scanner(raw);
    const rootStart = scanner.skip(bom);
    const root = scanner.object(rootStart);
    const nodesSpan = root.values.get("nodes");
    const nodes = nodesSpan ? scanner.array(nodesSpan.start) : null;
    const objects = (nodes?.items ?? []).map((item) => scanner.object(item.start));
    scan = { root, nodes, objects };
  } catch (error) {
    if (error instanceof NotJson) return null;
    throw error;
  }
  if (scan.objects.length !== oldNodes.length) return null;

  const replacements: Array<Span & { text: string }> = [];
  for (let index = 0; index < oldNodes.length; index += 1) {
    const old = oldNodes[index]!;
    const next = newNodes[index]!;
    if (sameJson(old, next)) continue;
    const keys = Object.keys(old);
    if (keys.length !== Object.keys(next).length || old.id !== next.id) return null;
    for (const key of keys) {
      if (sameJson(old[key], next[key])) continue;
      if (typeof old[key] !== "string" || typeof next[key] !== "string") return null;
      const span = scan.objects[index]!.values.get(key);
      if (!span) return null;
      replacements.push({ ...span, text: JSON.stringify(next[key]) });
    }
  }

  const added = newNodes.slice(oldNodes.length);
  if (added.length > 0) {
    const { eol, unit } = layoutOf(raw);
    if (!scan.nodes) return null;
    const items = scan.nodes.items;
    if (items.length > 0) {
      const last = items[items.length - 1]!;
      // The text between two items (`,\n\t\t`, `, ` or `,`) is the separator to repeat.
      const separator = items.length > 1 ? raw.slice(items[items.length - 2]!.end, items[items.length - 1]!.start) : null;
      const lineStart = raw.lastIndexOf("\n", last.start) + 1;
      const indent = /^[ \t]*/.exec(raw.slice(lineStart, last.start))![0];
      const multiline = raw.slice(scan.nodes.start, last.start).includes("\n");
      const depth = unit.length > 0 ? Math.round(indent.length / unit.length) : 0;
      const between = separator ?? (multiline ? `,${eol}${indent}` : ",");
      const text = added.map((node) => (multiline ? layoutValue(node, unit, eol, depth) : JSON.stringify(node))).join(between);
      replacements.push({ start: last.end, end: last.end, text: `${between}${text}` });
    } else {
      // `"nodes":[]`: Obsidian's layout around the new items, one level deeper than the key.
      const keyLine = raw.lastIndexOf("\n", scan.nodes.start) + 1;
      const keyIndent = /^[ \t]*/.exec(raw.slice(keyLine))![0];
      const multiline = raw.slice(scan.root.start, scan.root.end).includes("\n");
      if (multiline) {
        const depth = unit.length > 0 ? Math.round(keyIndent.length / unit.length) : 0;
        const inner = added.map((node) => `${keyIndent}${unit}${layoutValue(node, unit, eol, depth + 1)}`).join(`,${eol}`);
        replacements.push({ start: scan.nodes.start, end: scan.nodes.end, text: `[${eol}${inner}${eol}${keyIndent}]` });
      } else {
        replacements.push({ start: scan.nodes.start, end: scan.nodes.end, text: `[${added.map((node) => JSON.stringify(node)).join(",")}]` });
      }
    }
  }

  if (replacements.length === 0) return raw;
  replacements.sort((a, b) => b.start - a.start);
  let out = raw;
  for (const { start, end, text } of replacements) out = out.slice(0, start) + text + out.slice(end);
  // Belt and braces: the result must be exactly the board asked for.
  try {
    if (!sameJson(JSON.parse(out.slice(bom)), now)) return null;
  } catch {
    return null;
  }
  return out;
}
