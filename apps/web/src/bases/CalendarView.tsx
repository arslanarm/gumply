/**
 * Gumply's Calendar layout (D34, spec/api-bases): a month grid of pages by
 * `dateProperty` (optionally to `endDateProperty`). Drag a page to another
 * day to change its date; "+" on a day makes a page dated that day.
 * Obsidian shows "Unknown view type: calendar" for it and keeps it.
 */
import { useMemo, useState } from "react";
import { noteKey, propertyId, type BaseRow, type BaseValue } from "@gumply/core";
import { Icon } from "../components/Icon.js";
import { dateFormat, useT } from "../i18n/index.js";
import type { LayoutProps } from "./layouts.js";

const ROW_MIME = "application/x-gumply-base-row";
/** More than this many pages on a day: "+N more". */
const PER_DAY = 4;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "ноябрь 2026 г." → "Ноябрь 2026 г." (only the first letter: CSS capitalize would make it "Г."). */
function firstUpper(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

function dayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `YYYY-MM-DD` (and an optional time) → that local day. */
function parseDay(value: BaseValue): Date | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Monday-first weeks (ISO), as most calendars in our languages show them. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  const days: Date[] = [];
  for (let i = 0; i < 42; i += 1) days.push(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  // Drop a trailing week that's entirely next month.
  return days.slice(35).every((day) => day.getMonth() !== month.getMonth()) ? days.slice(0, 35) : days;
}

export function CalendarView(props: LayoutProps & { today?: Date }) {
  const t = useT();
  const { view, result } = props;
  const today = props.today ?? new Date();
  const dateId = typeof view.dateProperty === "string" && view.dateProperty ? propertyId(view.dateProperty) : "file.ctime";
  const endId = typeof view.endDateProperty === "string" && view.endDateProperty ? propertyId(view.endDateProperty) : null;
  const dateKey = noteKey(dateId);
  const movable = dateKey !== null && !props.readOnly && !!props.onSetValue;

  const [month, setMonth] = useState(() => new Date(today.getFullYear(), today.getMonth(), 1));
  const [over, setOver] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, BaseRow[]>();
    for (const row of result.rows) {
      const start = parseDay(row.values[dateId] ?? null);
      if (!start) continue;
      const end = endId ? parseDay(row.values[endId] ?? null) : null;
      const last = end && end > start ? end : start;
      // Multi-day pages show on each day (capped at 62 days).
      for (let day = new Date(start), n = 0; day <= last && n < 62; day.setDate(day.getDate() + 1), n += 1) {
        const key = dayKey(day);
        let list = map.get(key);
        if (!list) map.set(key, (list = []));
        list.push(row);
      }
    }
    return map;
  }, [result.rows, dateId, endId]);

  const days = monthGrid(month);
  const weekdays = days.slice(0, 7).map((day) => dateFormat({ weekday: "short" }).format(day));
  const undated = result.rows.filter((row) => !parseDay(row.values[dateId] ?? null)).length;

  const moveTo = (rowId: string, day: Date) => {
    const row = result.rows.find((item) => item.id === rowId);
    if (!row || !dateKey || !props.onSetValue) return;
    const current = row.values[dateId];
    const text = typeof current === "string" ? current : "";
    if (text.startsWith(dayKey(day))) return;
    // Keep a time of day when the page had one.
    const time = /T\d{2}:\d{2}/.exec(text)?.[0] ?? "";
    void props.onSetValue(row, dateKey, `${dayKey(day)}${time}`);
  };

  return (
    <div className="base-layout base-calendar" data-testid="base-calendar">
      <div className="base-calendar-head">
        <h4 className="base-calendar-month" data-testid="base-calendar-month">
          {firstUpper(dateFormat({ month: "long", year: "numeric" }).format(month))}
        </h4>
        <div className="base-calendar-nav">
          <button
            type="button"
            className="icon-button"
            aria-label={t("bases.previousMonth")}
            data-tooltip={t("bases.previousMonth")}
            data-testid="base-calendar-prev"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          >
            <Icon name="chevronRight" size={16} className="base-flip" />
          </button>
          <button
            type="button"
            className="base-tool"
            data-testid="base-calendar-today"
            onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}
          >
            {t("bases.today")}
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t("bases.nextMonth")}
            data-tooltip={t("bases.nextMonth")}
            data-testid="base-calendar-next"
            onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          >
            <Icon name="chevronRight" size={16} />
          </button>
        </div>
      </div>
      <div className="base-calendar-grid" role="grid">
        {weekdays.map((name, index) => (
          <div key={index} className="base-calendar-weekday" role="columnheader">
            {name}
          </div>
        ))}
        {days.map((day) => {
          const key = dayKey(day);
          const rows = byDay.get(key) ?? [];
          const shown = expanded === key ? rows : rows.slice(0, PER_DAY);
          const outside = day.getMonth() !== month.getMonth();
          return (
            <div
              key={key}
              role="gridcell"
              className={`base-calendar-day${outside ? " is-outside" : ""}${key === dayKey(today) ? " is-today" : ""}${over === key ? " is-over" : ""}`}
              data-testid={`base-day-${key}`}
              onDragOver={(event) => {
                if (!movable || !event.dataTransfer.types.includes(ROW_MIME)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOver(key);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
              }}
              onDrop={(event) => {
                setOver(null);
                const id = event.dataTransfer.getData(ROW_MIME);
                if (!id) return;
                event.preventDefault();
                moveTo(id, day);
              }}
            >
              <div className="base-calendar-date">
                <span>{day.getDate()}</span>
                {props.onNewRow && !props.readOnly && dateKey ? (
                  <button
                    type="button"
                    className="base-calendar-add"
                    aria-label={t("bases.newOn", { date: dateFormat({ dateStyle: "medium" }).format(day) })}
                    data-testid={`base-new-on-${key}`}
                    onClick={() => props.onNewRow?.({ [dateKey]: key })}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                ) : null}
              </div>
              {shown.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="base-calendar-item"
                  draggable={movable}
                  data-testid={`base-event-${row.id}`}
                  onDragStart={(event) => {
                    event.dataTransfer.setData(ROW_MIME, row.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => props.onOpen(row.id)}
                >
                  {row.icon ? <span aria-hidden="true">{row.icon}</span> : null}
                  <span>{row.title}</span>
                </button>
              ))}
              {rows.length > shown.length ? (
                <button type="button" className="base-calendar-more" onClick={() => setExpanded(key)}>
                  {t("bases.moreOnDay", { count: rows.length - shown.length })}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {undated > 0 ? <p className="base-panel-note">{t("bases.undated", { count: undated })}</p> : null}
    </div>
  );
}
