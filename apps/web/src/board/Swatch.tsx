/** A colour swatch button for the context toolbars. */
import type { CSSProperties } from "react";
import { PALETTE, solidColor } from "./colors.js";

export function Swatch({ value, label, active, onPick }: {
  value: string | undefined;
  label: string;
  active: boolean;
  onPick: (value: string | undefined) => void;
}) {
  return (
    <button
      type="button"
      className={`board-swatch${active ? " is-active" : ""}${value ? "" : " is-default"}`}
      style={{ "--swatch": solidColor(value) ?? "var(--board-ink)" } as CSSProperties}
      aria-label={label}
      aria-pressed={active}
      data-tooltip={label}
      data-testid={`board-color-${value ?? "default"}`}
      onClick={() => onPick(value)}
    />
  );
}

/** Default plus the six presets. */
export function Palette({ current, onPick }: { current: string | null | undefined; onPick: (value: string | undefined) => void }) {
  return (
    <div className="board-context-group">
      {PALETTE.map((entry) => (
        <Swatch key={entry.label} value={entry.value} label={entry.label} active={current === entry.value} onPick={onPick} />
      ))}
    </div>
  );
}
