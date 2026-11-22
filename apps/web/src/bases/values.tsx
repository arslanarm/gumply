/**
 * Showing a base value outside the table (cards, list, kanban, calendar),
 * and the layout settings Obsidian 1.14.4 writes, with its defaults
 * (@opus-hunter's fixture, spec/api-bases). A setting at its default is
 * removed from the file, as Obsidian does.
 */
import { createContext, useContext, type CSSProperties } from "react";
import { resolveWikilink, type BaseColumn, type BaseRow, type BaseValue, type BaseView, type PageId, type PageMeta } from "@gumply/core";
import { fileUrl } from "../api/client.js";
import { Icon } from "../components/Icon.js";
import { hasWikilink, LinkedText } from "../components/PropertyLinks.js";
import { useT } from "../i18n/index.js";
import { isTitleColumn } from "./labels.js";
import { display } from "./TableView.js";

/** What `[[links]]` in values need: the vault's pages and how to open one (#vc4hivrr). */
export const BaseLinks = createContext<{ pages: readonly PageMeta[]; onOpen: (id: PageId) => void } | null>(null);

/**
 * A text value with its `[[links]]` as links (a page opens; an attachment
 * opens the file, resolved from the row's page). Other text as `display`.
 */
export function BaseText({ text, rowId }: { text: string; rowId: string }) {
  const links = useContext(BaseLinks);
  if (!links || !hasWikilink(text)) return <>{display(text, "text")}</>;
  return (
    <LinkedText
      text={text}
      pages={links.pages}
      from={rowId}
      onOpen={(link) => {
        const page = resolveWikilink(link.targetTitle, links.pages);
        if (page) links.onOpen(page.id);
      }}
    />
  );
}

/** One value, compact: chips for lists, a tick for checkboxes, dates in the interface language. */
export function ValueText({ value, column, rowId }: { value: BaseValue; column: BaseColumn; rowId: string }) {
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
            {column.type === "tags" ? `#${item.replace(/^#/, "")}` : <BaseText text={item} rowId={rowId} />}
          </span>
        ))}
      </span>
    );
  }
  return <span className="base-value">{typeof value === "string" && column.type === "text" ? <BaseText text={value} rowId={rowId} /> : display(value, column.type)}</span>;
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
  const link = (wiki ? wiki[1]! : text).trim();
  if (!/\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(link)) return null;
  // #8k4ssrkb: the server resolved it across the vault, from this row's page.
  if (row.files && Object.hasOwn(row.files, link)) {
    const path = row.files[link];
    return path ? { url: fileUrl(path) } : null;
  }
  // A plain vault path (not a wikilink) is used as written.
  return wiki ? null : { url: fileUrl(link) };
}

/**
 * A card's cover. Cards: a box of the card's width at `imageAspectRatio`.
 * Kanban (`height`): a fixed box, the card's width × `columnWidth ×
 * imageAspectRatio` tall, as Obsidian 1.14.4 draws it (@opus-hunter's
 * measurement, #armmzdrx). `contain` letterboxes inside the box on a muted
 * fill, `cover` fills it, a colour fills it.
 */
export function ImageBox({
  row,
  view,
  ratio,
  height,
  placeholder,
}: {
  row: BaseRow;
  view: BaseView;
  ratio: number;
  height?: number;
  /** No cover of its own: an empty box of the same size, so titles line up with cover cards (#2su9ikg4). */
  placeholder?: boolean;
}) {
  const image = imageOf(row, view);
  const size: CSSProperties = height !== undefined ? { height } : { aspectRatio: `${1 / ratio}` };
  if (!image) {
    return placeholder ? <div className="base-card-image is-empty" data-testid="base-card-image-empty" style={size} aria-hidden="true" /> : null;
  }
  const fit = view.imageFit === "contain" ? "contain" : "cover";
  return (
    <div className="base-card-image" data-testid="base-card-image" style={{ ...size, background: image.color }} aria-hidden="true">
      {image.url ? <img src={image.url} alt="" loading="lazy" style={{ objectFit: fit }} /> : null}
    </div>
  );
}
