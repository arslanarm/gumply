/**
 * The selection toolbar (#bg3cb83t), Notion's bubble: select text with the
 * mouse or Shift+arrows and it appears above the selection (below it near
 * the top of the window). Turn into, Bold, Italic, Strikethrough, Inline
 * code, Highlight, Colour (#h368c8ni) and Link; active marks show pressed.
 *
 * It never takes focus by itself, so typing goes on in the text. Alt+F10
 * moves focus into it (arrows move between buttons) and Escape gives focus
 * back to the text. Mod+K with a selection opens its link field.
 */
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../i18n/index.js";
import { blockAt } from "../lib/blocks.js";
import { buildLinkSuggestions, type LinkSuggestion } from "../lib/wikilinks.js";
import { TURN_INTO, turnInto } from "../editor/block-editing.js";
import {
  canFormat,
  canHighlight,
  linkKeys,
  linkSelectionToPage,
  markActions,
  normaliseUrl,
  removeLink,
  setLink,
  setLinkFieldOpener,
  toggleMark,
} from "../editor/formatting.js";
import { getWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { linkTargetFor } from "@gumply/core";
import { Icon } from "./Icon.js";
import { ColorPalette, ColorSample } from "./ColorPalette.js";
import { currentColor, paletteName } from "../editor/color.js";

export interface SelectionToolbarProps {
  editor: Editor;
}

type Mode = "buttons" | "link" | "turn" | "color";

interface Place {
  left: number;
  /** The selection's top and bottom edges (viewport px). */
  above: number;
  below: number;
}

const GAP = 8;
/** The app's top bar: the toolbar never goes under it. */
const TOP_LIMIT = 56;

export function SelectionToolbar({ editor }: SelectionToolbarProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const [mode, setMode] = useState<Mode>("buttons");
  /** The colour palette was opened from the keyboard: focus its first swatch. */
  const [paletteFocus, setPaletteFocus] = useState(false);
  const [, setVersion] = useState(0);
  const pointerDown = useRef(false);
  const dismissed = useRef<string | null>(null);

  const selectionKey = () => `${editor.state.selection.from}:${editor.state.selection.to}`;

  const recheck = useRef(0);
  const measure = useCallback((): void => {
    const focused = editor.view.hasFocus() || (ref.current?.contains(document.activeElement) ?? false);
    // Focus moving from the text into the toolbar (Alt+F10, the link field)
    // passes through <body> for a moment: decide once it has landed.
    if (!focused && recheck.current === 0) {
      recheck.current = requestAnimationFrame(() => {
        recheck.current = 0;
        const landed = editor.view.hasFocus() || (ref.current?.contains(document.activeElement) ?? false);
        if (!landed) {
          setPlace(null);
          setMode("buttons");
        }
      });
      return;
    }
    if (!focused) return;
    if (pointerDown.current || !canHighlight(editor) || dismissed.current === selectionKey()) {
      setPlace(null);
      setMode("buttons");
      return;
    }
    const { from, to } = editor.state.selection;
    const start = editor.view.coordsAtPos(from);
    const end = editor.view.coordsAtPos(to, -1);
    const top = Math.min(start.top, end.top);
    const bottom = Math.max(start.bottom, end.bottom);
    // Centre over the selection's first line (or the span when on one line).
    const sameLine = Math.abs(start.top - end.top) < 4;
    const centre = sameLine ? (start.left + end.right) / 2 : start.left + 120;
    setPlace({ left: centre, above: top, below: bottom });
    setVersion((value) => value + 1);
    // `selectionKey` reads the live editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    const update = () => measure();
    // Focus moving into the toolbar keeps it; anywhere else hides it.
    const onBlur = () => measure();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    editor.on("focus", update);
    editor.on("blur", onBlur);
    const dom = editor.view.dom;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerDown.current = true;
      dismissed.current = null;
      setPlace(null);
    };
    const onPointerUp = () => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      // After the browser settles the selection.
      requestAnimationFrame(() => measure());
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape in the text dismisses the bar for this selection (it comes
      // back when the selection changes); other keys clear that.
      if (event.key === "Escape") {
        dismissed.current = selectionKey();
        setPlace(null);
        setMode("buttons");
        return;
      }
      if (event.key !== "Shift" && event.key !== "Alt") dismissed.current = null;
    };
    dom.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    dom.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
      editor.off("focus", update);
      editor.off("blur", onBlur);
      dom.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      dom.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [editor, measure]);

  // Mod+K and Alt+F10 from the text.
  useEffect(() => {
    setLinkFieldOpener(() => {
      if (!canFormat(editor)) return false;
      dismissed.current = null;
      measure();
      setMode("link");
      return true;
    });
    return () => setLinkFieldOpener(null);
  }, [editor, measure]);

  useEffect(() => {
    const dom = editor.view.dom;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "F10" || !event.altKey || !place) return;
      event.preventDefault();
      ref.current?.querySelector<HTMLElement>("button")?.focus();
    };
    dom.addEventListener("keydown", onKeyDown);
    return () => dom.removeEventListener("keydown", onKeyDown);
  }, [editor, place]);

  // Place the bar once it has a size, with whatever is open in it (the
  // palette, Turn into, page results): above the selection, or below it
  // when there's no room above. It never covers the selected text.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !place) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const left = Math.max(8, Math.min(place.left - width / 2, window.innerWidth - width - 8));
    const fitsAbove = place.above - height - GAP >= TOP_LIMIT;
    element.style.left = `${left}px`;
    element.style.top = `${fitsAbove ? place.above - height - GAP : place.below + GAP}px`;
    element.classList.toggle("is-below", !fitsAbove);
    // Above: what opens (palette, Turn into) goes on top, so the buttons stay next to the text.
    element.classList.toggle("is-above", fitsAbove);
  });

  const close = () => {
    dismissed.current = selectionKey();
    setMode("buttons");
    setPlace(null);
    editor.commands.focus();
  };

  const onToolbarKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (mode !== "buttons") {
        setMode("buttons");
        requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>("button")?.focus());
      } else close();
      return;
    }
    if (mode !== "buttons" && mode !== "turn") return;
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const vertical = mode === "turn";
    const forward = vertical ? event.key === "ArrowDown" : event.key === "ArrowRight";
    const backward = vertical ? event.key === "ArrowUp" : event.key === "ArrowLeft";
    if (!forward && !backward) return;
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>(vertical ? ".selection-turn-list button" : ".selection-toolbar-buttons > button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (buttons.length === 0) return;
    event.preventDefault();
    buttons[(index + (forward ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  };

  if (!place) return null;

  // Keep the text selection: buttons act on mousedown without taking focus.
  const keep = (event: React.MouseEvent) => event.preventDefault();
  const linkActive = editor.isActive("link");

  return (
    <div
      ref={ref}
      className="selection-toolbar"
      role="toolbar"
      aria-label={t("format.toolbarLabel")}
      data-testid="selection-toolbar"
      style={{ left: place.left, top: place.above }}
      onMouseDown={(event) => {
        if (!(event.target as HTMLElement).closest("input")) keep(event);
      }}
      onKeyDown={onToolbarKeyDown}
    >
      {mode === "link" ? (
        <LinkField
          editor={editor}
          initial={linkActive ? String(editor.getAttributes("link").href ?? "") : ""}
          onDone={() => {
            setMode("buttons");
            dismissed.current = selectionKey();
            setPlace(null);
          }}
          onCancel={() => {
            setMode("buttons");
            editor.commands.focus();
          }}
          onRemove={linkActive ? () => removeLink(editor) : undefined}
        />
      ) : (
        <div className="selection-toolbar-buttons">
          <button
            type="button"
            className={`selection-turn-button${mode === "turn" ? " is-open" : ""}`}
            data-testid="selection-turn-into"
            aria-haspopup="menu"
            aria-expanded={mode === "turn"}
            // #hwrv5hvk: the visible block name alone ("Text") doesn't say what the button does.
            aria-label={t("blocks.turnIntoLabel", { block: currentBlockLabel(editor) })}
            data-tooltip={t("blocks.turnIntoHeading")}
            onClick={() => setMode(mode === "turn" ? "buttons" : "turn")}
          >
            {currentBlockLabel(editor)}
            <Icon name="chevronDown" size={13} />
          </button>
          <span className="selection-toolbar-divider" aria-hidden="true" />
          {markActions()
            // #gcba75f4: on wiki links alone, no code (it would turn the link into literal text).
            .filter((action) => canFormat(editor) || action.mark !== "code")
            .map((action) => {
            const active = editor.isActive(action.mark);
            return (
              <button
                key={action.mark}
                type="button"
                className={`selection-toolbar-button${active ? " is-active" : ""}`}
                aria-label={action.label}
                aria-pressed={active}
                data-tooltip={`${action.label} · ${action.keys}`}
                data-testid={`format-${action.mark}`}
                onClick={() => toggleMark(editor, action.mark)}
              >
                <Icon name={action.icon} size={16} />
              </button>
            );
          })}
          <button
            type="button"
            className={`selection-toolbar-button selection-color-button${mode === "color" ? " is-open" : ""}`}
            aria-label={t("format.color")}
            aria-haspopup="true"
            aria-expanded={mode === "color"}
            data-tooltip={t("format.color")}
            data-testid="format-color"
            onClick={(event) => {
              // detail 0: Enter or Space, not a click.
              setPaletteFocus(event.detail === 0);
              setMode(mode === "color" ? "buttons" : "color");
            }}
          >
            <ColorSample choice={{ kind: "text", name: paletteName("text", currentColor(editor, "text")) }} />
            <Icon name="chevronDown" size={11} />
          </button>
          {canFormat(editor) ? (
            <button
              type="button"
              className={`selection-toolbar-button${linkActive ? " is-active" : ""}`}
              aria-label={t("format.link")}
              aria-pressed={linkActive}
              data-tooltip={t("format.linkTooltip", { keys: linkKeys() })}
              data-testid="format-link"
              onClick={() => setMode("link")}
            >
              <Icon name="link" size={16} />
            </button>
          ) : null}
        </div>
      )}
      {mode === "turn" ? (
        <div className="selection-turn-list" role="menu" data-testid="selection-turn-menu">
          {TURN_INTO.map((item) => (
            <button
              key={item.kind}
              type="button"
              role="menuitem"
              data-testid={`selection-turn-${item.kind}`}
              onClick={() => {
                const block = blockAt(editor.state.doc, editor.state.selection.from);
                setMode("buttons");
                if (block) turnInto(editor, block, item.kind);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
      {mode === "color" ? (
        <div className="selection-color-menu">
          <ColorPalette
            editor={editor}
            autoFocus={paletteFocus}
            testId="selection-color-palette"
            onPick={() => {
              setMode("buttons");
              if (paletteFocus) editor.commands.focus();
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** "Text", "Heading 1"… for the Turn into button. */
function currentBlockLabel(editor: Editor): string {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    switch (node.type.name) {
      case "heading":
        return t("format.headingLevel", { level: String(node.attrs.level) });
      case "codeBlock":
        return t("blocks.turnInto.code");
      case "taskItem":
        return t("blocks.turnInto.todo");
      case "listItem":
        return $from.node(depth - 1).type.name === "orderedList" ? t("blocks.turnInto.ordered") : t("blocks.turnInto.bullet");
      case "blockquote":
        return t("blocks.turnInto.quote");
      case "callout":
        return node.attrs.fold ? t("blocks.turnInto.toggle") : t("blocks.turnInto.callout");
      default:
        break;
    }
  }
  return t("blocks.turnInto.text");
}

interface LinkFieldProps {
  editor: Editor;
  initial: string;
  onDone: () => void;
  onCancel: () => void;
  onRemove?: () => void;
}

/** A URL, or `[[` (or any non-URL text) to search pages for a wiki link. */
function LinkField({ editor, initial, onDone, onCancel, onRemove }: LinkFieldProps) {
  const [value, setValue] = useState(initial);
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const url = normaliseUrl(value);
  const query = value.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
  const env = getWikiLinkEnvironment();
  const pages: LinkSuggestion[] =
    url === null && query.length > 0 ? buildLinkSuggestions(env.pages, query).filter((item) => item.kind === "page").slice(0, 6) : [];

  const pick = (item: LinkSuggestion) => {
    const page = env.pages.find((candidate) => candidate.id === item.pageId);
    if (!page) return;
    const { target, alias } = linkTargetFor(page, env.pages);
    linkSelectionToPage(editor, target, alias);
    onDone();
  };

  const submit = () => {
    if (url) {
      setLink(editor, url);
      onDone();
      return;
    }
    const item = pages[index];
    if (item) pick(item);
  };

  return (
    <div className="selection-link" data-testid="selection-link">
      <Icon name="link" size={15} />
      <input
        ref={inputRef}
        className="selection-link-input"
        data-testid="selection-link-input"
        aria-label={t("format.linkFieldLabel")}
        placeholder={t("format.linkPlaceholder")}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "ArrowDown" && pages.length > 0) {
            event.preventDefault();
            setIndex((current) => (current + 1) % pages.length);
          } else if (event.key === "ArrowUp" && pages.length > 0) {
            event.preventDefault();
            setIndex((current) => (current - 1 + pages.length) % pages.length);
          }
        }}
      />
      {onRemove ? (
        <button
          type="button"
          className="selection-toolbar-button"
          aria-label={t("editorMenu.removeLink")}
          data-tooltip={t("editorMenu.removeLink")}
          data-testid="selection-link-remove"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onRemove();
            onDone();
          }}
        >
          <Icon name="unlink" size={15} />
        </button>
      ) : null}
      {pages.length > 0 ? (
        <div className="selection-link-pages" role="listbox" aria-label={t("format.pagesLabel")} data-testid="selection-link-pages">
          {pages.map((item, itemIndex) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={itemIndex === index}
              className={itemIndex === index ? "is-active" : ""}
              data-testid={`selection-link-page-${item.pageId}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(item)}
            >
              <span className="selection-link-page-icon" aria-hidden="true">
                {item.icon ?? <Icon name={item.board ? "board" : "file"} size={15} />}
              </span>
              {item.label}
            </button>
          ))}
        </div>
      ) : url === null && value.trim().length > 0 ? (
        <div className="selection-link-pages selection-link-hint">{t("format.noPagesMatch")}</div>
      ) : null}
    </div>
  );
}
