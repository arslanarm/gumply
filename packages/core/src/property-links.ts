/**
 * Where `[[links]]` can sit in a page's frontmatter (#3c86ify2): the one walk
 * that both the rename rewrite (server `rewritePropertyLinks`) and the link
 * index (#rpugpydh) use, so what is rewritten and what counts as a link can't
 * disagree.
 *
 * A span is a top-level text value, an item of a list of text values, or an
 * unquoted `[[Target]]` (YAML reads that as a list in a list; Obsidian and its
 * users read it as a link). Gumply's header keys, block scalars
 * (`|`, `>`), anchors, YAML tags and multi-line values are never spans.
 */
import { isMap, isScalar, isSeq, parseDocument, type Node } from "yaml";
import { extractWikilinks, hasAttachmentExtension, type WikiLink } from "./links.js";
import { HEADER_KEYS } from "./properties.js";
import { WIKILINK_INNER, wikilinkTargetPart } from "./wikilink-syntax.js";

export type PropertyLinkStyle = "double" | "single" | "plain" | "flow-link";

export interface PropertyLinkSpan {
  /** The top-level key the value belongs to. */
  key: string;
  /** `[start, end)` of the value's source text in the YAML (quotes included). */
  start: number;
  end: number;
  style: PropertyLinkStyle;
  /** The decoded text (`"\\[[X]]"` → `\[[X]]`); for `flow-link`, the text as written. */
  value: string;
}

const FLOW_LINK = new RegExp(String.raw`^\[\[${WIKILINK_INNER}+\]\]$`);

type Ranged = Node & { range?: [number, number, number] };

function flowLink(node: Node | null | undefined, yaml: string): string | null {
  if (!isSeq(node) || !node.flow || node.anchor || node.tag) return null;
  const range = (node as Ranged).range;
  if (!range) return null;
  const text = yaml.slice(range[0], range[1]);
  return FLOW_LINK.test(text) ? text : null;
}

function textScalar(node: Node | null | undefined): { value: string; style: PropertyLinkStyle } | null {
  if (!isScalar(node) || node.anchor || node.tag || typeof node.value !== "string" || node.value.includes("\n")) return null;
  if (node.type === "QUOTE_DOUBLE") return { value: node.value, style: "double" };
  if (node.type === "QUOTE_SINGLE") return { value: node.value, style: "single" };
  if (node.type === "PLAIN") return { value: node.value, style: "plain" };
  return null; // block scalars
}

/**
 * Every text value a frontmatter link can sit in, in file order (values
 * without `[[` included, so a caller can compare two walks position by
 * position). `null` when the YAML doesn't parse or isn't a mapping.
 */
export function propertyLinkSpans(yaml: string): PropertyLinkSpan[] | null {
  const document = parseDocument(yaml, { uniqueKeys: false, prettyErrors: false });
  if (document.errors.length > 0 || !isMap(document.contents)) return null;
  const spans: PropertyLinkSpan[] = [];
  const seen = new Set<string>();
  const visit = (key: string, node: Node | null | undefined) => {
    const range = (node as Ranged | null | undefined)?.range;
    if (!node || !range) return;
    const flow = flowLink(node, yaml);
    if (flow !== null) {
      spans.push({ key, start: range[0], end: range[1], style: "flow-link", value: flow });
      return;
    }
    const scalar = textScalar(node);
    if (scalar) spans.push({ key, start: range[0], end: range[1], ...scalar });
  };
  for (const pair of document.contents.items) {
    const keyNode = pair.key as Node | null;
    if (!isScalar(keyNode) || typeof keyNode.value !== "string") continue;
    const key = keyNode.value;
    // The first of a repeated key, as everywhere else Gumply reads frontmatter; Gumply's header keys as it writes them.
    // `tags`, `aliases` and `cssclasses` are walked like any key (#7xbdttxy): Obsidian 1.14 counts a
    // whole-value `"[[Alpha]]"` there as a link (and never as a tag or an alias, see `normalizeTags`, `mentionTerms`).
    if (HEADER_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    const value = pair.value as Node | null;
    if (isSeq(value) && flowLink(value, yaml) === null) {
      if (value.anchor || value.tag) continue;
      for (const item of value.items) visit(key, item as Node);
    } else {
      visit(key, value);
    }
  }
  return spans;
}

/** A frontmatter value that links a page (#rpugpydh). */
export interface PropertyPageLink {
  key: string;
  link: WikiLink;
}

/** A frontmatter value that links a vault file (`"[[report.pdf]]"`): the name as written before `|` and `#`. */
export interface PropertyFileLink {
  key: string;
  name: string;
}

export interface PropertyLinks {
  pages: PropertyPageLink[];
  files: PropertyFileLink[];
}

const WHOLE_LINK = new RegExp(String.raw`^\[\[(${WIKILINK_INNER}+)\]\]$`);

/**
 * The frontmatter values that count as links for the graph and backlinks
 * (#rpugpydh, @opus-hunter's `vault-c1obs/` table). A value counts only when
 * the whole decoded value is exactly one non-embed `[[link]]`: `"[[Alpha]]"`,
 * `"[[Alpha#Sec]]"`, `"[[Alpha|A]]"`, a list item `- "[[Alpha]]"`. Never:
 * text around the link or two links (nothing counts), spaces around it (no
 * trim), an embed `"![[Alpha]]"`, an escaped `"\\[[Alpha]]"`, and the unquoted
 * `up: [[Alpha]]` (YAML reads a nested list). A whole-value link to an
 * attachment-type file (`"[[a.pdf]]"`) is a file link instead.
 * `null` when there are none (or the YAML doesn't parse).
 */
export function propertyLinks(yaml: string | null | undefined): PropertyLinks | null {
  if (!yaml || !yaml.includes("[[")) return null;
  const spans = propertyLinkSpans(yaml);
  if (!spans) return null;
  const pages: PropertyPageLink[] = [];
  const files: PropertyFileLink[] = [];
  for (const span of spans) {
    if (span.style === "flow-link" || !span.value.startsWith("[[")) continue;
    const links = extractWikilinks(span.value);
    if (links.length === 1) {
      const link = links[0]!;
      if (link.raw === span.value && !link.embed) pages.push({ key: span.key, link });
      continue;
    }
    if (links.length > 0) continue;
    const whole = WHOLE_LINK.exec(span.value);
    const name = whole ? wikilinkTargetPart(whole[1]!).split("#")[0]!.trim() : "";
    if (name && hasAttachmentExtension(name)) files.push({ key: span.key, name });
  }
  return pages.length > 0 || files.length > 0 ? { pages, files } : null;
}

/** A plain YAML scalar that would read back as something else, or not as one string, needs quotes. */
function plainNeedsQuotes(value: string): boolean {
  return (
    value.length === 0 ||
    value !== value.trim() ||
    /^[\[\]{}#&*!|>'"%@`,?:-]/.test(value) ||
    /: | #|[\n\t]/.test(value) ||
    /:$/.test(value) ||
    /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|\.inf|\.nan)$/i.test(value)
  );
}

/**
 * The source text for a new value in a span's own style: `"double"` as JSON,
 * `'single'` with `'` doubled, plain unless it now needs quotes (then double),
 * and a `flow-link` as written.
 */
export function encodePropertyValue(style: PropertyLinkStyle, value: string): string {
  if (style === "flow-link") return value;
  if (style === "single") return `'${value.replace(/'/g, "''")}'`;
  if (style === "plain" && !plainNeedsQuotes(value)) return value;
  return JSON.stringify(value);
}
