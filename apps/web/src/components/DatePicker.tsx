/**
 * A date or date-and-time property value (#93wnicas): the value as text in
 * the app's date format and the interface language; a click (or Enter /
 * Space) opens a small month picker under it. The file gets exactly what the
 * browser's native input used to write: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { dateFormat, useLanguage, useT } from "../i18n/index.js";
import {
  addDays,
  addMonths,
  formatDateValue,
  formatTime,
  monthGrid,
  parseDateValue,
  parseTime,
  sameDay,
  toFileValue,
  todayParts,
  weekStart,
  type DateParts,
} from "../lib/dates.js";
import { Icon } from "./Icon.js";

export interface DatePickerProps {
  /** The value as written in the file (anything; a non-date shows as written). */
  value: string;
  datetime: boolean;
  /** The property's name, for screen readers. */
  label: string;
  /** Open at once (a table cell that is already in edit mode). */
  autoOpen?: boolean;
  /** The new file value: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or "" for Clear. */
  onChange: (next: string) => void;
}

const capitalise = (text: string) => text.charAt(0).toLocaleUpperCase() + text.slice(1);

export function DatePicker({ value, datetime, label, autoOpen = false, onChange }: DatePickerProps) {
  const t = useT();
  const language = useLanguage();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(autoOpen);
  const parsed = parseDateValue(value);
  const shown = formatDateValue(value);
  const visible = shown ?? (value || t("datePicker.empty"));

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`date-picker-value${shown === null && !value ? " is-empty" : ""}`}
        data-testid="date-picker-value"
        // WCAG 2.5.3: the name holds what the button shows ("due: Dec 1, 2026"),
        // so "click Dec 1" works for speech users (a11y audit P3, #jchhjepb).
        aria-label={`${label}: ${visible}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="calendar" size={14} />
        <span>{visible}</span>
      </button>
      {open ? (
        <DatePopover
          key={language}
          anchorRef={buttonRef}
          selected={parsed}
          datetime={datetime}
          onPick={(next) => {
            onChange(next);
            if (!datetime || next === "") close(true);
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function DatePopover(props: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  selected: DateParts | null;
  datetime: boolean;
  onPick: (next: string) => void;
  onClose: (refocus: boolean) => void;
}) {
  const t = useT();
  const { anchorRef, selected, datetime, onPick, onClose } = props;
  const panelRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const today = todayParts();
  // The day the keyboard is on; the month shown follows it.
  const [focus, setFocus] = useState<DateParts>(() => selected ?? today);
  const [time, setTime] = useState(() => formatTime(selected?.hour !== undefined ? selected : { hour: 0, minute: 0 }));
  const [timeInvalid, setTimeInvalid] = useState(false);
  // Only a time someone typed is written (leaving the untouched field writes nothing).
  const [timeDirty, setTimeDirty] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const firstDay = weekStart();
  const cells = useMemo(() => monthGrid(focus.year, focus.month, firstDay), [focus.year, focus.month, firstDay]);

  // Fixed under the value, kept inside the window.
  useLayoutEffect(() => {
    const place = () => {
      const panel = panelRef.current;
      const anchor = anchorRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = rect.bottom + 4;
      const top = below + height > window.innerHeight - 8 && rect.top - height - 4 > 8 ? rect.top - height - 4 : below;
      setStyle({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchorRef]);

  // A click outside closes it without writing.
  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [anchorRef, onClose]);

  // The keyboard starts on the chosen day (or today), once the panel is placed (hidden until then).
  const placed = style.visibility !== "hidden";
  useEffect(() => {
    if (placed) gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus();
  }, [placed]);

  const moveTo = (next: DateParts) => {
    setFocus(next);
    // After the render that shows its month.
    requestAnimationFrame(() => gridRef.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus());
  };

  const pick = (day: Pick<DateParts, "year" | "month" | "day">) => {
    const clock = datetime ? (parseTime(time) ?? { hour: selected?.hour ?? 0, minute: selected?.minute ?? 0 }) : {};
    onPick(toFileValue({ ...day, ...clock }, datetime));
  };

  const onGridKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, () => DateParts> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -((new Date(focus.year, focus.month - 1, focus.day).getDay() - firstDay + 7) % 7)),
      End: () => addDays(focus, 6 - ((new Date(focus.year, focus.month - 1, focus.day).getDay() - firstDay + 7) % 7)),
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    moveTo(step());
  };

  const commitTime = () => {
    if (!timeDirty) return;
    const clock = parseTime(time);
    setTimeInvalid(clock === null);
    if (!clock) return;
    setTimeDirty(false);
    setTime(formatTime(clock));
    const day = selected ?? focus;
    if (selected && selected.hour === clock.hour && selected.minute === clock.minute) return;
    onPick(toFileValue({ year: day.year, month: day.month, day: day.day, ...clock }, true));
  };

  const monthLabel = capitalise(dateFormat({ month: "long", year: "numeric" }).format(new Date(focus.year, focus.month - 1, 1)));
  const weekdays = cells.slice(0, 7).map((cell) => {
    const name = dateFormat({ weekday: "short" }).format(new Date(cell.year, cell.month - 1, cell.day));
    return capitalise(name.replace(/\.$/, "").slice(0, 2));
  });
  const fullDate = (cell: Pick<DateParts, "year" | "month" | "day">) => dateFormat({ dateStyle: "long" }).format(new Date(cell.year, cell.month - 1, cell.day));

  return createPortal(
    <div
      ref={panelRef}
      className="date-picker"
      role="dialog"
      aria-label={t("datePicker.choose")}
      data-testid="date-picker"
      style={style}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose(true);
      }}
    >
      <div className="date-picker-header">
        <span className="date-picker-month" aria-live="polite" data-testid="date-picker-month">
          {monthLabel}
        </span>
        <button type="button" className="date-picker-nav" aria-label={t("datePicker.previousMonth")} data-tooltip={t("datePicker.previousMonth")} onClick={() => setFocus(addMonths(focus, -1))}>
          <Icon name="chevronLeft" size={14} />
        </button>
        <button type="button" className="date-picker-nav" aria-label={t("datePicker.nextMonth")} data-tooltip={t("datePicker.nextMonth")} onClick={() => setFocus(addMonths(focus, 1))}>
          <Icon name="chevronRight" size={14} />
        </button>
      </div>
      <div className="date-picker-grid" role="grid" ref={gridRef} onKeyDown={onGridKey} data-testid="date-picker-grid">
        <div className="date-picker-row" role="row">
          {weekdays.map((name, index) => (
            <span key={index} className="date-picker-weekday" role="columnheader">
              {name}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div className="date-picker-row" role="row" key={week}>
            {cells.slice(week * 7, week * 7 + 7).map((cell) => {
              const chosen = sameDay(cell, selected);
              const focused = sameDay(cell, focus);
              const id = toFileValue(cell, false);
              return (
                <button
                  key={id}
                  type="button"
                  role="gridcell"
                  className={`date-picker-day${cell.inMonth ? "" : " is-outside"}${sameDay(cell, today) ? " is-today" : ""}${chosen ? " is-selected" : ""}`}
                  aria-selected={chosen}
                  aria-label={fullDate(cell)}
                  tabIndex={focused ? 0 : -1}
                  data-testid={`date-picker-day-${id}`}
                  onClick={() => pick(cell)}
                >
                  {cell.day}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {datetime ? (
        <label className="date-picker-time">
          <Icon name="clock" size={14} />
          <input
            className={`date-picker-time-input${timeInvalid ? " is-invalid" : ""}`}
            data-testid="date-picker-time"
            inputMode="numeric"
            placeholder="HH:mm"
            aria-label={t("datePicker.time")}
            aria-invalid={timeInvalid}
            value={time}
            onChange={(event) => {
              setTime(event.target.value);
              setTimeDirty(true);
              setTimeInvalid(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitTime();
              }
            }}
            onBlur={commitTime}
          />
        </label>
      ) : null}
      <div className="date-picker-footer">
        <button type="button" className="date-picker-action" data-testid="date-picker-today" onClick={() => pick(today)}>
          {t("datePicker.today")}
        </button>
        <button type="button" className="date-picker-action" data-testid="date-picker-clear" onClick={() => onPick("")}>
          {t("datePicker.clear")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
