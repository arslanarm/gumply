/**
 * Syntax highlighting for code blocks (#zvhhn84v), as ProseMirror inline
 * decorations from lowlight (highlight.js grammars).
 *
 * Unlike @tiptap/extension-code-block-lowlight this never auto-detects: a
 * block without a language, or with one we don't know, stays plain text. And
 * everything heavy is loaded on demand: lowlight itself the first time a
 * highlighted block appears, each grammar the first time it is used. When a
 * grammar arrives, a meta-only transaction redraws (no document change, so no
 * autosave and nothing in undo history).
 */
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { findLanguage, type CodeLanguage } from "./languages.js";

type Lowlight = {
  register(name: string, grammar: unknown): void;
  registered(name: string): boolean;
  highlight(name: string, value: string): { children: HastNode[] };
};
type HastNode = {
  type: string;
  value?: string;
  properties?: { className?: string[] };
  children?: HastNode[];
};

export const codeHighlightKey = new PluginKey<DecorationSet>("gumplyCodeHighlight");

let lowlightPromise: Promise<Lowlight> | null = null;
let lowlight: Lowlight | null = null;
const grammarLoads = new Map<string, Promise<void>>();

function loadLowlight(): Promise<Lowlight> {
  lowlightPromise ??= import("./lowlight-core.js").then(
    (module) => {
      lowlight = module.createLowlight() as unknown as Lowlight;
      return lowlight;
    },
    (error: unknown) => {
      // Offline or server restarted: let the next code block try again
      // instead of staying unhighlighted until a reload (#fzfrkpta).
      lowlightPromise = null;
      throw error;
    },
  );
  return lowlightPromise;
}

/** Load lowlight and the grammar for `language`; resolves when usable. */
export function loadGrammar(language: CodeLanguage): Promise<void> {
  const existing = grammarLoads.get(language.id);
  if (existing) return existing;
  const load = Promise.all([loadLowlight(), language.grammar!()]).then(([instance, module]) => {
    if (!instance.registered(language.id)) instance.register(language.id, module.default);
  });
  // A failed chunk load may be retried later.
  load.catch(() => grammarLoads.delete(language.id));
  grammarLoads.set(language.id, load);
  return load;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function hastToHtml(nodes: HastNode[]): string {
  return nodes
    .map((node) =>
      node.type === "text"
        ? escapeHtml(node.value ?? "")
        : `<span class="${escapeHtml((node.properties?.className ?? []).join(" "))}">${hastToHtml(node.children ?? [])}</span>`,
    )
    .join("");
}

/**
 * Highlighted HTML for `code` in `languageName` (read-only views such as page
 * previews, #5dpxwac4), with the same lazily loaded grammars as the editor.
 * Null for an unknown language; the text is escaped.
 */
export async function highlightToHtml(languageName: string, code: string): Promise<string | null> {
  const language = findLanguage(languageName);
  if (!language?.grammar) return null;
  await loadGrammar(language);
  return hastToHtml(lowlight!.highlight(language.id, code).children);
}

function isReady(language: CodeLanguage): boolean {
  return lowlight !== null && lowlight.registered(language.id);
}

interface Span {
  from: number;
  to: number;
  className: string;
}

/** Flatten lowlight's tree into class spans over the text offsets. */
function spansFor(tree: HastNode[]): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  const walk = (nodes: HastNode[], classes: string[]) => {
    for (const node of nodes) {
      if (node.type === "text") {
        const length = node.value?.length ?? 0;
        if (classes.length && length) spans.push({ from: offset, to: offset + length, className: classes.join(" ") });
        offset += length;
      } else if (node.children) {
        walk(node.children, [...classes, ...(node.properties?.className ?? [])]);
      }
    }
  };
  walk(tree, []);
  return spans;
}

// Per code-block node (immutable, so unchanged blocks reuse their spans).
const spanCache = new WeakMap<PMNode, Span[]>();

function decorationsFor(doc: PMNode, typeName: string, missing: Set<CodeLanguage>): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== typeName) return true;
    const language = findLanguage(node.attrs.language as string | null);
    if (!language) return false;
    if (!isReady(language)) {
      missing.add(language);
      return false;
    }
    let spans = spanCache.get(node);
    if (!spans) {
      try {
        spans = spansFor(lowlight!.highlight(language.id, node.textContent).children);
      } catch {
        spans = [];
      }
      spanCache.set(node, spans);
    }
    for (const span of spans) {
      decorations.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, { class: span.className }));
    }
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/** Redraw once the grammars a document needs have loaded (once per load). */
function requestGrammars(
  view: EditorView | null,
  missing: Set<CodeLanguage>,
  waiting: Set<string>,
): void {
  if (!view) return;
  for (const language of missing) {
    if (waiting.has(language.id)) continue;
    waiting.add(language.id);
    void loadGrammar(language).then(
      () => {
        waiting.delete(language.id);
        if (view.isDestroyed) return;
        view.dispatch(view.state.tr.setMeta(codeHighlightKey, "refresh").setMeta("addToHistory", false));
      },
      () => waiting.delete(language.id),
    );
  }
}

export function codeHighlightPlugin(typeName: string): Plugin<DecorationSet> {
  let view: EditorView | null = null;
  let pending = new Set<CodeLanguage>();
  const waiting = new Set<string>();

  const compute = (state: EditorState | { doc: PMNode }) => {
    const missing = new Set<CodeLanguage>();
    const set = decorationsFor(state.doc, typeName, missing);
    pending = missing;
    return set;
  };

  return new Plugin<DecorationSet>({
    key: codeHighlightKey,
    state: {
      init: (_, state) => compute(state),
      apply(tr, previous, _old, next) {
        if (tr.docChanged || tr.getMeta(codeHighlightKey) === "refresh") return compute(next);
        return previous;
      },
    },
    props: {
      decorations(state) {
        return codeHighlightKey.getState(state);
      },
    },
    view(editorView) {
      view = editorView;
      requestGrammars(view, pending, waiting);
      return {
        update() {
          requestGrammars(view, pending, waiting);
        },
        destroy() {
          view = null;
        },
      };
    },
  });
}
