/**
 * The colour palette (#h368c8ni), shared by the selection toolbar and the
 * editor's right-click menu: the last used colour first, then Text colour
 * and Background, each Default plus Obsidian's palette (and gray).
 *
 * Keyboard: arrows move through the grid (Left/Right in a row, Up/Down
 * between rows), Enter or Space applies, Escape is handled by the menu
 * around it.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useId, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../i18n/index.js";
import { applyColor, COLOR_NAMES, currentColor, linkCanTake, linkCoverage, paletteName, type ColorKind, type ColorName } from "../editor/color.js";

export interface ColorChoice {
  kind: ColorKind;
  /** null: Default (no colour). */
  name: ColorName | null;
}

const LAST_USED_KEY = "gumply.lastColor";

export function lastUsedColor(): ColorChoice | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(LAST_USED_KEY) ?? "null") as ColorChoice | null;
    if (value && (value.kind === "text" || value.kind === "background") && (COLOR_NAMES as readonly string[]).includes(String(value.name))) {
      return value;
    }
  } catch {
    // Unreadable: no last colour.
  }
  return null;
}

function rememberColor(choice: ColorChoice): void {
  if (!choice.name) return;
  try {
    window.localStorage.setItem(LAST_USED_KEY, JSON.stringify(choice));
  } catch {
    // Storage full or blocked: nothing to remember.
  }
}

/** "Red text", "Default background"… */
export function colorLabel(choice: ColorChoice): string {
  const name = choice.name ? t(`format.colors.${choice.name}`) : t("format.colorDefault");
  return t(choice.kind === "text" ? "format.textColorNamed" : "format.backgroundNamed", { name });
}

/** Colour the selection and remember the choice. */
export function pickColor(editor: Editor, choice: ColorChoice): void {
  applyColor(editor, choice.kind, choice.name);
  rememberColor(choice);
}

/** The small "A" sample of a choice, styled by the palette CSS. */
export function ColorSample({ choice }: { choice: ColorChoice }) {
  return (
    <span
      className={`color-sample is-${choice.kind}`}
      data-palette={choice.name ?? "default"}
      aria-hidden="true"
    >
      A
    </span>
  );
}

export interface ColorPaletteProps {
  editor: Editor;
  /** After a colour is applied. */
  onPick: () => void;
  /** Focus the first swatch on open (keyboard use). */
  autoFocus?: boolean;
  testId?: string;
}

export function ColorPalette({ editor, onPick, autoFocus, testId = "color-palette" }: ColorPaletteProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const noteId = useId();
  const last = lastUsedColor();
  // #gcba75f4: links keep their colour (only yellow highlights one and keeps it working in Obsidian).
  const links = linkCoverage(editor);
  const blocked = (choice: ColorChoice) => links === "only" && !linkCanTake(choice.kind, choice.name);
  const current: Record<ColorKind, ColorName | null> = {
    text: paletteName("text", currentColor(editor, "text")),
    background: paletteName("background", currentColor(editor, "background")),
  };

  useEffect(() => {
    if (autoFocus) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [autoFocus]);

  const pick = (choice: ColorChoice) => {
    if (blocked(choice)) return;
    pickColor(editor, choice);
    onPick();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>(".color-palette-row") ?? [])].map((row) => [
      ...row.querySelectorAll<HTMLButtonElement>("button"),
    ]);
    const active = document.activeElement as HTMLButtonElement | null;
    let rowIndex = rows.findIndex((row) => row.includes(active!));
    if (rowIndex < 0) return;
    event.preventDefault();
    event.stopPropagation();
    let column = rows[rowIndex]!.indexOf(active!);
    if (event.key === "ArrowLeft") column -= 1;
    else if (event.key === "ArrowRight") column += 1;
    else if (event.key === "Home") column = 0;
    else if (event.key === "End") column = rows[rowIndex]!.length - 1;
    else rowIndex = (rowIndex + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
    const row = rows[rowIndex]!;
    // Wrap within the row; keep the column when changing rows (clamped).
    if (column < 0) column = row.length - 1;
    if (column >= row.length) column = event.key === "ArrowRight" ? 0 : row.length - 1;
    row[column]?.focus();
  };

  const swatch = (choice: ColorChoice, extraClass = "") => {
    const selected = current[choice.kind] === choice.name;
    const label = colorLabel(choice);
    const off = blocked(choice);
    return (
      <button
        key={`${choice.kind}-${choice.name ?? "default"}`}
        type="button"
        className={`color-swatch${selected ? " is-selected" : ""}${off ? " is-unavailable" : ""}${extraClass}`}
        aria-label={label}
        aria-pressed={selected}
        // Still focusable, so the keyboard grid keeps its shape and the reason can be read.
        aria-disabled={off || undefined}
        aria-describedby={off ? noteId : undefined}
        // The reason is the note right below (and aria-describedby): a long tooltip ran off a narrow window.
        data-tooltip={label}
        data-testid={`color-${choice.kind}-${choice.name ?? "default"}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => pick(choice)}
      >
        <ColorSample choice={choice} />
      </button>
    );
  };

  const section = (kind: ColorKind) => (
    <div className="color-palette-section" role="group" aria-label={t(kind === "text" ? "format.textColor" : "format.background")}>
      <div className="color-palette-title">{t(kind === "text" ? "format.textColor" : "format.background")}</div>
      <div className="color-palette-row">
        {[null, ...COLOR_NAMES].map((name) => swatch({ kind, name }))}
      </div>
    </div>
  );

  return (
    <div ref={ref} className="color-palette" data-testid={testId} aria-label={t("format.colorLabel")} onKeyDown={onKeyDown}>
      {last ? (
        <div className="color-palette-section" role="group" aria-label={t("format.lastUsed")}>
          <div className="color-palette-title">{t("format.lastUsed")}</div>
          <div className="color-palette-row">
            <button
              type="button"
              className={`color-last${blocked(last) ? " is-unavailable" : ""}`}
              data-testid="color-last-used"
              aria-disabled={blocked(last) || undefined}
              aria-describedby={blocked(last) ? noteId : undefined}
              aria-label={`${t("format.lastUsed")}: ${colorLabel(last)}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(last)}
            >
              <ColorSample choice={last} />
              <span>{colorLabel(last)}</span>
            </button>
          </div>
        </div>
      ) : null}
      {section("text")}
      {section("background")}
      {links !== "none" ? (
        <p className="color-palette-note" id={noteId} role="note" data-testid="color-link-note">
          {t(links === "only" ? "format.linkOnlyYellow" : "format.linksKeepColour")}
        </p>
      ) : null}
    </div>
  );
}
