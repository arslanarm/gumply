import { isValidTagName } from "@gumply/core";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/index.js";

export interface TagRenameDialogProps {
  tag: string;
  /** Pages and boards with the tag (nested ones included). */
  count: number;
  /** Whether a different tag already has the new name (they merge). */
  exists: (name: string) => boolean;
  onCancel: () => void;
  onRename: (to: string) => void;
}

/**
 * Rename a tag everywhere (#9bx3aznb): the new name, with the page count and
 * a note when it merges into an existing tag. The input is focused; Escape
 * and a click outside cancel; Tab stays inside (D15).
 */
export function TagRenameDialog({ tag, count, exists, onCancel, onRename }: TagRenameDialogProps) {
  const t = useT();
  const id = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState(tag);
  const name = value.trim().replace(/^#/, "");
  const valid = isValidTagName(name);
  const changed = name !== tag;
  const merges = valid && name.toLowerCase() !== tag.toLowerCase() && exists(name);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>("input, button:not([disabled])");
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  const submit = () => {
    if (valid && changed) onRename(name);
  };

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="modal tag-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        data-testid="tag-rename-dialog"
        ref={dialogRef}
      >
        <h2 id={`${id}-title`}>{t("tags.renameTag", { tag })}</h2>
        <p id={`${id}-body`}>{t("tags.renameCount", { tag, count })}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="tag-rename-field">
            <span className="tag-rename-hash" aria-hidden="true">
              #
            </span>
            <input
              ref={inputRef}
              value={value}
              aria-label={t("tags.newName")}
              aria-invalid={!valid}
              data-testid="tag-rename-input"
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <p className={`tag-rename-note${valid ? "" : " tag-rename-error"}`} data-testid="tag-rename-note" aria-live="polite">
            {!valid ? t("tags.invalid") : merges ? t("tags.merges", { tag: name }) : " "}
          </p>
          <div className="modal-actions">
            <button type="button" className="button-secondary" data-testid="tag-rename-cancel" onClick={onCancel}>
              {t("common.cancel")}
            </button>
            <button type="submit" className="button-primary" data-testid="tag-rename-confirm" disabled={!valid || !changed}>
              {t("tags.renameButton")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
