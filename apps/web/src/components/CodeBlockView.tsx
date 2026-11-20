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

/**
 * Notion-style code block (#zvhhn84v): a language button (searchable picker)
 * and a Copy button over the code. The language is written on the fence.
 */
export function CodeBlockView({ node, updateAttributes, editor, getPos }: NodeViewProps) {
  const language = String(node.attrs.language ?? "");
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const known = findLanguage(language);

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
      className={`code-block${open ? " is-picking" : ""}`}
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
          title={language && !known ? `“${language}” is kept as written, shown as plain text` : "Change language"}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setOpen((value) => !value)}
        >
          {languageLabel(language)}
          <Icon name="chevronDown" size={12} />
        </button>
        <button
          type="button"
          className="code-block-copy"
          data-testid="code-copy"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void copy()}
        >
          {copied ? "Copied" : "Copy"}
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
        placeholder="Search for a language…"
        aria-label="Search for a language"
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
      <div className="code-language-list" role="listbox" aria-label="Languages">
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
        {results.length === 0 ? <p className="code-language-empty">No languages found.</p> : null}
      </div>
    </div>
  );
}
