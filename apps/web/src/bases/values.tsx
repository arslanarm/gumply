/**
 * Showing a base value outside the table (cards, list, kanban, calendar),
 * and the layout settings Obsidian 1.14.4 writes, with its defaults
 * (@opus-hunter's fixture, spec/api-bases). A setting at its default is
 * removed from the file, as Obsidian does.
 */
import type { BaseColumn, BaseRow, BaseValue, BaseView } from "@gumply/core";
import { fileUrl } from "../api/client.js";
import { Icon } from "../components/Icon.js";
import { useT } from "../i18n/index.js";
import { isTitleColumn } from "./labels.js";
import { display } from "./TableView.js";

/** One value, compact: chips for lists, a tick for checkboxes, dates in the interface language. */
export function ValueText({ value, column }: { value: BaseValue; column: BaseColumn }) {
  const t = useT();
  if (value === null || value === "" || (Array.isArray(value) && value.length === 0)) return null;
  if (typeof value === "boolean") {
    return (
      <span className="base-bool" aria-label={value ? t("bases.trueValue") : t("bases.falseValue")}>
        {value ? <Icon name="checkSquare" size={14} /> : <span className="base-bool-off" />}
      </span>
    );
  }
  if (Array.isArray(value)) {
    return (
      <span className="base-chips">
        {value.map((item, index) => (
          <span className="base-chip" key={`${item}-${index}`}>
            {column.type === "tags" ? `#${item.replace(/^#/, "")}` : display(item, "text")}
          </span>
        ))}
      </span>
    );
  }
  return <span className="base-value">{display(value, column.type)}</span>;
}

/** The columns a card or list item shows under its title. */
export function detailColumns(columns: readonly BaseColumn[]): BaseColumn[] {
  return columns.filter((column) => !isTitleColumn(column.id));
}

/** A number setting, clamped to Obsidian's range; the default when absent. */
export function numberSetting(view: BaseView, key: string, fallback: number, min: number, max: number): number {
  const value = view[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** The view with `key` set, or removed when `value` is the default (as Obsidian writes). */
export function withSetting(view: BaseView, key: string, value: unknown, fallback: unknown): BaseView {
  const next: BaseView = { ...view };
  if (value === fallback || value === undefined || value === "") delete next[key];
  else next[key] = value;
  return next;
}

/**
 * What an image property holds, as Obsidian reads it: a `[[wikilink]]` to an
 * attachment, an external URL, or a hex colour (spec/api-bases, cards).
 */
export function imageOf(row: BaseRow, view: BaseView): { url?: string; color?: string } | null {
  const id = typeof view.image === "string" ? view.image : null;
  if (!id) return null;
  const key = id.includes(".") ? id : `note.${id}`;
  let value = row.values[key];
  if (Array.isArray(value)) value = value[0] ?? null;
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return { color: text };
  if (/^https?:\/\//i.test(text)) return { url: text };
  const wiki = /^!?\[\[([^\]|#]+)/.exec(text);
  const path = (wiki ? wiki[1]! : text).trim();
  if (!/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(path)) return null;
  // A bare name is looked up in attachments/ (where Gumply keeps images, D18).
  return { url: fileUrl(path.includes("/") ? path : `attachments/${path}`) };
}

export function ImageBox({ row, view, ratio }: { row: BaseRow; view: BaseView; ratio: number }) {
  const image = imageOf(row, view);
  if (!image) return null;
  const fit = view.imageFit === "contain" ? "contain" : "cover";
  return (
    <div className="base-card-image" style={{ aspectRatio: `${1 / ratio}`, background: image.color }} aria-hidden="true">
      {image.url ? <img src={image.url} alt="" loading="lazy" style={{ objectFit: fit }} /> : null}
    </div>
  );
}
