import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon.js";

export interface UndoToastProps {
  message: string;
  /** Defaults to the bin of the delete toast (D11). */
  icon?: IconName;
  duration?: number;
  onUndo?: () => void;
  onDismiss: () => void;
}

/**
 * Delete toast with Undo (D11): 8s, paused while hovered or focused.
 * Remaining time is tracked so pausing never resets the window.
 */
export function UndoToast({
  message,
  icon = "trash",
  duration = 8000,
  onUndo,
  onDismiss,
}: UndoToastProps) {
  const [paused, setPaused] = useState(false);
  const remaining = useRef(duration);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (paused) return;

    startedAt.current = Date.now();
    const timer = setTimeout(onDismiss, remaining.current);

    return () => {
      clearTimeout(timer);
      if (startedAt.current !== null) {
        remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
        startedAt.current = null;
      }
    };
  }, [paused, onDismiss]);

  return (
    <div
      className="toast"
      role="status"
      aria-live="polite"
      data-testid="undo-toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <span className="toast-icon" aria-hidden="true">
        <Icon name={icon} size={15} />
      </span>
      <span>{message}</span>
      {onUndo ? (
        <button
          type="button"
          className="link-button"
          data-testid="undo-delete"
          onClick={() => {
            onDismiss();
            onUndo();
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}
