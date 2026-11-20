/**
 * Code-block languages (#zvhhn84v).
 *
 * The language lives on the Markdown fence (```` ```ts ````). The picker
 * offers ~30 common languages; anything else read from a file is kept exactly
 * as written and shown as plain text. Grammars are highlight.js modules loaded
 * on demand, so none of them weigh on the main bundle.
 */
import type { LanguageFn } from "highlight.js";

export interface CodeLanguage {
  /** What the picker writes on the fence. */
  id: string;
  label: string;
  /** Other fence names that mean the same language (lower case). */
  aliases?: string[];
  /** highlight.js grammar to load; none for plain text. */
  grammar?: () => Promise<{ default: LanguageFn }>;
}

/** Shown first in the picker; an empty fence. */
export const PLAIN_TEXT: CodeLanguage = { id: "", label: "Plain text", aliases: ["text", "plaintext", "txt", "plain"] };

export const CODE_LANGUAGES: readonly CodeLanguage[] = [
  PLAIN_TEXT,
  { id: "bash", label: "Bash", aliases: ["sh", "shell", "zsh", "console"], grammar: () => import("highlight.js/lib/languages/bash") },
  { id: "c", label: "C", aliases: ["h"], grammar: () => import("highlight.js/lib/languages/c") },
  { id: "cpp", label: "C++", aliases: ["c++", "hpp", "cc"], grammar: () => import("highlight.js/lib/languages/cpp") },
  { id: "csharp", label: "C#", aliases: ["cs", "c#"], grammar: () => import("highlight.js/lib/languages/csharp") },
  { id: "css", label: "CSS", grammar: () => import("highlight.js/lib/languages/css") },
  { id: "diff", label: "Diff", aliases: ["patch"], grammar: () => import("highlight.js/lib/languages/diff") },
  { id: "dockerfile", label: "Dockerfile", aliases: ["docker"], grammar: () => import("highlight.js/lib/languages/dockerfile") },
  { id: "go", label: "Go", aliases: ["golang"], grammar: () => import("highlight.js/lib/languages/go") },
  { id: "graphql", label: "GraphQL", aliases: ["gql"], grammar: () => import("highlight.js/lib/languages/graphql") },
  { id: "html", label: "HTML", aliases: ["xhtml", "svg", "vue"], grammar: () => import("highlight.js/lib/languages/xml") },
  { id: "ini", label: "INI", aliases: ["cfg", "conf"], grammar: () => import("highlight.js/lib/languages/ini") },
  { id: "java", label: "Java", grammar: () => import("highlight.js/lib/languages/java") },
  { id: "js", label: "JavaScript", aliases: ["javascript", "jsx", "mjs", "cjs"], grammar: () => import("highlight.js/lib/languages/javascript") },
  { id: "json", label: "JSON", aliases: ["jsonc", "json5"], grammar: () => import("highlight.js/lib/languages/json") },
  { id: "kotlin", label: "Kotlin", aliases: ["kt"], grammar: () => import("highlight.js/lib/languages/kotlin") },
  { id: "lua", label: "Lua", grammar: () => import("highlight.js/lib/languages/lua") },
  { id: "makefile", label: "Makefile", aliases: ["make", "mk"], grammar: () => import("highlight.js/lib/languages/makefile") },
  { id: "md", label: "Markdown", aliases: ["markdown"], grammar: () => import("highlight.js/lib/languages/markdown") },
  { id: "php", label: "PHP", grammar: () => import("highlight.js/lib/languages/php") },
  { id: "python", label: "Python", aliases: ["py", "python3"], grammar: () => import("highlight.js/lib/languages/python") },
  { id: "r", label: "R", grammar: () => import("highlight.js/lib/languages/r") },
  { id: "ruby", label: "Ruby", aliases: ["rb"], grammar: () => import("highlight.js/lib/languages/ruby") },
  { id: "rust", label: "Rust", aliases: ["rs"], grammar: () => import("highlight.js/lib/languages/rust") },
  { id: "scss", label: "SCSS", aliases: ["sass"], grammar: () => import("highlight.js/lib/languages/scss") },
  { id: "sql", label: "SQL", aliases: ["postgres", "postgresql", "mysql", "sqlite"], grammar: () => import("highlight.js/lib/languages/sql") },
  { id: "swift", label: "Swift", grammar: () => import("highlight.js/lib/languages/swift") },
  { id: "toml", label: "TOML", grammar: () => import("highlight.js/lib/languages/ini") },
  { id: "ts", label: "TypeScript", aliases: ["typescript", "tsx", "mts", "cts"], grammar: () => import("highlight.js/lib/languages/typescript") },
  { id: "xml", label: "XML", aliases: ["plist", "rss", "xsd"], grammar: () => import("highlight.js/lib/languages/xml") },
  { id: "yaml", label: "YAML", aliases: ["yml"], grammar: () => import("highlight.js/lib/languages/yaml") },
];

const BY_NAME = new Map<string, CodeLanguage>();
for (const language of CODE_LANGUAGES) {
  if (language.id) BY_NAME.set(language.id, language);
  for (const alias of language.aliases ?? []) BY_NAME.set(alias, language);
}

/**
 * The known language for a fence name (case-insensitive), or null for plain
 * text and for names we don't know (those are kept but not highlighted).
 */
export function findLanguage(name: string | null | undefined): CodeLanguage | null {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return null;
  const found = BY_NAME.get(key) ?? null;
  return found && found.grammar ? found : null;
}

/** Label for the picker button: known label, or the name as written. */
export function languageLabel(name: string | null | undefined): string {
  const value = (name ?? "").trim();
  if (!value || BY_NAME.get(value.toLowerCase()) === PLAIN_TEXT) return PLAIN_TEXT.label;
  return findLanguage(value)?.label ?? value;
}

/** Picker search over label, id and aliases. */
export function searchLanguages(query: string): CodeLanguage[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...CODE_LANGUAGES];
  const starts: CodeLanguage[] = [];
  const contains: CodeLanguage[] = [];
  for (const language of CODE_LANGUAGES) {
    const names = [language.label.toLowerCase(), language.id, ...(language.aliases ?? [])];
    if (names.some((name) => name.startsWith(q))) starts.push(language);
    else if (names.some((name) => name.includes(q))) contains.push(language);
  }
  return [...starts, ...contains];
}

/**
 * A fence name typed right after ```` ``` ```` (e.g. "python") names a
 * language when it is one of ours: lower-case letters, digits, + and #.
 */
export function typedLanguage(text: string): string | null {
  const value = text.trim();
  if (!/^[A-Za-z][\w+#-]*$/.test(value)) return null;
  const lower = value.toLowerCase();
  const known = BY_NAME.get(lower);
  return known && known !== PLAIN_TEXT ? value : null;
}
