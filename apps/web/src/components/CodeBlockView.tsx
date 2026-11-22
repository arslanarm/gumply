import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  findLanguage,
  languageLabel,
  searchLanguages,
  type CodeLanguage,
} from "../editor/code/languages.js";
import { loadGrammar } from "../editor/code/highlight-plugin.js";
import { Icon } from "./Icon.js";
import { t, useT } from "../i18n/index.js";
import { mountDiagram } from "../lib/diagram.js";

/** F2: whether the caret (or a selection) is inside this block's text. */
function useCaretInside(editor: NodeViewProps["editor"], getPos: NodeViewProps["getPos"], size: number): boolean {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    const check = () => {
      const pos = typeof getPos === "function" ? getPos() : undefined;
      if (typeof pos !== "number" || !editor.isFocused) return setInside(false);
      const { from, to } = editor.state.selection;
      setInside(from > pos && to <= pos + 1 + size);
    };
    check();
    editor.on("selectionUpdate", check);
    editor.on("focus", check);
    editor.on("blur", check);
    return () => {
      editor.off("selectionUpdate", check);
      editor.off("focus", check);
      editor.off("blur", check);
    };
  }, [editor, getPos, size]);
  return inside;
}

/**
 * F2: a ```mermaid block shows its diagram; the source shows while the caret
 * is in the block (a click on the diagram puts it there; Esc leaves). The
 * diagram follows the source, debounced while typing.
 */
function MermaidPreview({ source, editing, onEdit }: { source: string; editing: boolean; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const timer = window.setTimeout(() => void mountDiagram(element, source), editing ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [source, editing]);
  return (
    <div
      ref={ref}
      className={`code-block-diagram${editing ? " is-editing" : ""}`}
      data-testid="mermaid-diagram"
      contentEditable={false}
      role={editing ? undefined : "button"}
      tabIndex={editing ? -1 : 0}
      title={editing ? undefined : t("diagram.clickToEdit")}
      onMouseDown={(event) => {
        if (editing) return;
        event.preventDefault();
        onEdit();
      }}
      onKeyDown={(event) => {
        if (!editing && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onEdit();
        }
      }}
    />
  );
}

/**
 * Notion-style code block (#zvhhn84v): a language button (searchable picker)
 * and a Copy button over the code. The language is written on the fence.
 */
export function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const t = useT();
  const language = String(node.attrs.language ?? "");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const known = findLanguage(language);
  // An unknown fence shows as written: `{r echo=FALSE}`, not `{r`.
  const info = String(node.attrs.markdownInfo ?? "");
  const label = !known && language && info.startsWith(language) ? info : languageLabel(language);
  const diagram = known?.id === "mermaid";
  const editing = useCaretInside(editor, getPos, node.content.size);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const backToCode = () => {
    const pos = typeof getPos === "function" ? getPos() : undefined;
    if (typeof pos === "number") editor.chain().focus(pos + 1 + node.content.size).run();
    else editor.commands.focus();
  };

  const choose = (choice: CodeLanguage) => {
    setOpen(false);
    // Start fetching the grammar right away; the block redraws when it lands.
    if (choice.grammar) void loadGrammar(choice).catch(() => undefined);
    updateAttributes({ language: choice.id || null });
    backToCode();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.textContent);
      setCopied(true);
    } catch {
      // Clipboard blocked (permissions, insecure context): nothing to show.
    }
  };

  return (
    <NodeViewWrapper
      className={`code-block${open ? " is-picking" : ""}${diagram ? ` is-diagram${editing ? " is-editing" : ""}` : ""}`}
      data-testid="code-block"
      data-language={language}
    >
      <div className="code-block-bar" contentEditable={false}>
        <button
          ref={buttonRef}
          type="button"
          className={`code-block-language${known || !language ? "" : " is-unknown"}`}
          data-testid="code-language-button"
          aria-haspopup="listbox"
          aria-expanded={open}
          title={language && !known ? t("code.unknownLanguage", { language }) : t("code.changeLanguage")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="code-block-language-text">{label}</span>
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          type="button"
          className="code-block-copy"
          data-testid="code-copy"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void copy()}
        >
          {copied ? t("code.copied") : t("code.copy")}
        </button>
        {open ? (
          <LanguagePicker
            current={language}
            onChoose={choose}
            onClose={() => {
              setOpen(false);
              backToCode();
            }}
          />
        ) : null}
      </div>
      <pre spellCheck={false}>
        <NodeViewContent as="code" className={known ? `language-${known.id}` : undefined} />
      </pre>
      {diagram ? (
        <MermaidPreview
          source={node.textContent}
          editing={editing}
          onEdit={() => {
            const pos = typeof getPos === "function" ? getPos() : undefined;
            if (typeof pos === "number") editor.chain().focus(pos + 1).run();
          }}
        />
      ) : null}
    </NodeViewWrapper>
  );
}

function LanguagePicker({
  current,
  onChoose,
  onClose,
}: {
  current: string;
  onChoose: (language: CodeLanguage) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const results = useMemo(() => searchLanguages(query), [query]);
  const currentId = findLanguage(current)?.id ?? (current ? null : "");

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // A click anywhere else closes the picker.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  return (
    <div className="code-language-picker" ref={rootRef} data-testid="code-language-picker">
      <input
        ref={inputRef}
        type="text"
        value={query}
        placeholder={t("code.searchPlaceholder")}
        aria-label={t("code.searchLabel")}
        data-testid="code-language-search"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((value) => Math.min(results.length - 1, value + 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((value) => Math.max(0, value - 1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const choice = results[active];
            if (choice) onChoose(choice);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <div className="code-language-list" role="listbox" aria-label={t("code.languages")}>
        {results.map((language, index) => (
          <button
            key={language.label}
            type="button"
            role="option"
            data-index={index}
            data-testid={`code-language-option-${language.id || "plain"}`}
            aria-selected={index === active}
            className={`code-language-option${index === active ? " is-active" : ""}`}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setActive(index)}
            onClick={() => onChoose(language)}
          >
            <span>{language.label}</span>
            {language.id === currentId ? <span className="code-language-check">✓</span> : null}
          </button>
        ))}
        {results.length === 0 ? <p className="code-language-empty">{t("code.noLanguages")}</p> : null}
      </div>
    </div>
  );
}
