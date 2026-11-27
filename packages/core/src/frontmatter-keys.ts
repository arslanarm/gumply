/**
 * Obsidian reads the keys `tags` and `aliases` in any case (`Tags:`,
 * `ALIASES:`), plural only: `tag:` and `alias:` are ordinary properties
 * (#ippqkgus, measured in Obsidian 1.14.4).
 */
export function isTagsKey(key: string): boolean {
  return key.toLowerCase() === "tags";
}

export function isAliasesKey(key: string): boolean {
  return key.toLowerCase() === "aliases";
}

/**
 * The key a note uses for `tags` or `aliases`, as written: the first one in
 * file order whose name is that in any case. When a note has two spellings
 * (`tags:` and `Tags:`), Obsidian reads only the first, and Gumply reads and
 * writes only the first too; the other stays as written.
 */
export function frontmatterKey(keys: Iterable<string>, name: "tags" | "aliases"): string | undefined {
  for (const key of keys) if (key.toLowerCase() === name) return key;
  return undefined;
}

/** #8s94nyhn: a key as the narrow rule had it (letters, digits, `_`, `-`, inner spaces): written plain, byte for byte as before. */
const SIMPLE_KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]*$/u;
/** The old key line, tried first, so every line read before reads the same. */
const SIMPLE_KEY_LINE = /^([\p{L}\p{N}_][\p{L}\p{N}_ -]*?):(.*)$/u;
const DOUBLE_QUOTED_KEY_LINE = /^"((?:[^"\\]|\\.)*)"[ \t]*:(?=[ \t]|$)(.*)$/;
const SINGLE_QUOTED_KEY_LINE = /^'((?:[^']|'')*)'[ \t]*:(?=[ \t]|$)(.*)$/;
/** A plain YAML key with punctuation (`Water every (days): 7`, as Obsidian writes it): up to the first `:` before a space or the end. */
const PLAIN_KEY_LINE = /^([^\s\-?:,[\]{}#&*!|>'"%@`].*?)[ \t]*:(?=[ \t]|$)(.*)$/u;

/**
 * A top-level `key: value` line of a frontmatter block: the key (unquoted) and everything after its `:`.
 * Reads the narrow keys as before, then quoted keys and plain keys with punctuation. A plain key never
 * holds ` #` (a comment).
 */
export function matchKeyLine(line: string): { key: string; rest: string; written: string } | null {
  const found = readKeyLine(line);
  // The key as the file writes it (quotes and all), so a rewrite of its value keeps it byte for byte.
  return found ? { ...found, written: line.slice(0, line.length - found.rest.length - 1) } : null;
}

function readKeyLine(line: string): { key: string; rest: string } | null {
  const simple = SIMPLE_KEY_LINE.exec(line);
  if (simple) return { key: simple[1] ?? "", rest: simple[2] ?? "" };
  const double = DOUBLE_QUOTED_KEY_LINE.exec(line);
  if (double) {
    try {
      return { key: JSON.parse(`"${double[1] ?? ""}"`) as string, rest: double[2] ?? "" };
    } catch {
      return null;
    }
  }
  const single = SINGLE_QUOTED_KEY_LINE.exec(line);
  if (single) return { key: (single[1] ?? "").replace(/''/g, "'"), rest: single[2] ?? "" };
  const plain = PLAIN_KEY_LINE.exec(line);
  if (plain && !/[ \t]#/.test(plain[1] ?? "")) return { key: plain[1] ?? "", rest: plain[2] ?? "" };
  return null;
}

/** Whether a key must be quoted to read back as itself (YAML 1.2, as Obsidian parses it). */
function keyNeedsQuotes(key: string): boolean {
  return (
    key.length === 0 ||
    key !== key.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(key) ||
    /:([ \t]|$)|[ \t]#/.test(key) ||
    /["\\\p{Cc}]/u.test(key) ||
    /^(true|false|yes|no|on|off|null|~|[-+]?(\d[\d_]*)?\.?\d+([eE][-+]?\d+)?|0x[\da-f]+|0o[0-7]+|[-+]?\.inf|\.nan)$/i.test(key)
  );
}

/** A key as written in a frontmatter line: plain where YAML reads it back as itself, else double-quoted. */
export function yamlKey(key: string): string {
  // A narrow key stays plain, as it always was (Gumply's own reader takes `123:` as the key "123").
  if (SIMPLE_KEY.test(key)) return key;
  // Plain only where this file's own reader takes the line back as the same key (`a:b` would read as `a`).
  return keyNeedsQuotes(key) || readKeyLine(`${key}: x`)?.key !== key ? JSON.stringify(key) : key;
}
