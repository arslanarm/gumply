/**
 * Page cover and background (v0.7 F, #385sexd6; spec/api-page-look).
 *
 * The cover is a Notion-style banner above the title: a vault image, a
 * palette colour or a gradient, stored as frontmatter (`cover`,
 * `cover-position`). The background tints the page canvas (`background`).
 * Both are written through the property patch, so only their own lines
 * change (D37). Covers from the Obsidian Banners plugin (`banner:`) are shown
 * but never rewritten; "Hide in Gumply" writes `cover: none`.
 */
import {
  coverValue,
  PAGE_COLORS,
  PAGE_GRADIENTS,
  type Attachment,
  type VaultImage,
  type PageColor,
  type PageCover as Cover,
  type PageGradient,
  type PageLook,
  type PropertiesPatch,
} from "@gumply/core";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, fileUrl } from "../api/client.js";
import { obsidianFileUrl, useFileLinkVersion } from "../lib/file-links.js";
import { t, useT } from "../i18n/index.js";
import { errorMessage } from "../lib/errors.js";

/** `rgb` triplet variable of a palette colour (gray follows the theme's ink). */
export const colorRgb = (name: PageColor) => (name === "gray" ? "var(--mono-rgb-100)" : `var(--color-${name}-rgb)`);

/** Inline style for the page canvas tint, or nothing. */
export function backgroundStyle(look: PageLook): CSSProperties | undefined {
  return look.background ? ({ "--page-tint-rgb": colorRgb(look.background) } as CSSProperties) : undefined;
}

/** A colour cover's fill; gray is the theme's ink, so it is kept light. */
const coverFill = (name: PageColor) => `rgba(${colorRgb(name)}, ${name === "gray" ? 0.22 : 0.55})`;

/** Above this many images the Vault images tab gets a search box. */
const SEARCH_FROM = 30;

function coverStyle(cover: Cover, position: number): CSSProperties {
  if (cover.kind === "color") return { background: coverFill(cover.name) };
  if (cover.kind === "gradient") return {};
  return { objectPosition: `50% ${position}%` };
}

export interface PageCoverProps {
  look: PageLook;
  /** The open page: a cover link resolves from its folder, like any Obsidian link (#8k4ssrkb). */
  pageId: string;
  fileLinks?: Record<string, string | null> | null;
  /** The picker opens by itself right after "Add cover". */
  pickerSignal: number;
  onChange: (patch: PropertiesPatch) => Promise<boolean>;
}

export function PageCover({ look, pageId, fileLinks, pickerSignal, onChange }: PageCoverProps) {
  useT();
  // Re-render when a cover link typed after load has been resolved.
  useFileLinkVersion();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [reposition, setReposition] = useState<number | null>(null);
  // 0: first try; 1: the exact path failed, resolver tried; 2: nothing loads.
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ y: number; start: number; height: number } | null>(null);
  const cover = look.cover;
  const handled = useRef(pickerSignal);

  useEffect(() => {
    if (pickerSignal === handled.current) return;
    handled.current = pickerSignal;
    setPickerOpen(true);
  }, [pickerSignal]);
  useEffect(() => setAttempt(0), [cover && coverValue(cover)]);

  if (!cover && !pickerOpen) return null;

  const set = async (next: Cover) => {
    setPickerOpen(false);
    setError(null);
    // A new cover starts centred: the old focus belonged to the old image.
    await onChange({ set: { cover: coverValue(next) }, remove: ["cover-position"] });
  };
  const remove = async () => {
    setPickerOpen(false);
    if (look.coverSource === "banner") await onChange({ set: { cover: "none" } });
    else await onChange({ remove: ["cover", "cover-position"] });
  };
  const saveToVault = async () => {
    if (cover?.kind !== "url") return;
    setSaving(true);
    setError(null);
    try {
      const attachment = await api.importAttachment(cover.url);
      await set({ kind: "image", link: attachment.path });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setSaving(false);
    }
  };

  // A vault image resolves like Obsidian does. A path (what Gumply writes)
  // is tried exactly first, which also covers an image uploaded a moment
  // ago that the server's file index hasn't seen yet; a bare name, or a path
  // that isn't there, goes through the resolver (#8k4ssrkb). undefined while
  // the resolver is asked.
  const exactFirst = cover?.kind === "image" && cover.link.includes("/") && attempt === 0;
  const resolved =
    cover?.kind !== "image" ? null : exactFirst ? fileUrl(cover.link) : obsidianFileUrl(`[[${cover.link}]]`, pageId, fileLinks);
  const image = cover?.kind === "image" ? (resolved === undefined ? null : (resolved ?? "")) : cover?.kind === "url" ? cover.url : null;
  const loading = cover?.kind === "image" && resolved === undefined;
  const position = reposition ?? look.position;

  return (
    <div
      className={`page-cover${cover ? "" : " is-empty"}${reposition !== null ? " is-repositioning" : ""}`}
      data-testid="page-cover"
      data-cover-kind={cover?.kind ?? "none"}
    >
      {loading ? null : cover ? (
        image && attempt < 2 ? (
          <img
            className="page-cover-image"
            data-testid="page-cover-image"
            src={image}
            alt=""
            draggable={false}
            style={coverStyle(cover, position)}
            onError={() => setAttempt((value) => (exactFirst ? 1 : 2))}
            onPointerDown={(event) => {
              if (reposition === null) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { y: event.clientY, start: position, height: event.currentTarget.clientHeight };
            }}
            onPointerMove={(event) => {
              const state = drag.current;
              if (!state || reposition === null) return;
              // Dragging the image down shows more of its top: the focus moves up.
              const delta = ((event.clientY - state.y) / Math.max(state.height, 1)) * 100;
              setReposition(Math.min(100, Math.max(0, Math.round(state.start - delta))));
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          />
        ) : image !== null ? (
          <div className="page-cover-missing" data-testid="page-cover-missing">
            {t("cover.missing")}
          </div>
        ) : (
          <div
            className={`page-cover-fill${cover.kind === "gradient" ? ` cover-gradient-${cover.name}` : ""}`}
            data-testid="page-cover-fill"
            style={coverStyle(cover, position)}
          />
        )
      ) : null}

      {reposition !== null ? (
        <>
          <span className="page-cover-hint" aria-live="polite">
            {t("cover.dragHint")}
          </span>
          <div className="page-cover-actions is-visible">
            <button
              type="button"
              className="page-cover-button"
              data-testid="cover-reposition-save"
              onClick={() => {
                const value = reposition;
                setReposition(null);
                if (value !== look.position) void onChange({ set: { "cover-position": value } });
              }}
            >
              {t("cover.savePosition")}
            </button>
            <button type="button" className="page-cover-button" data-testid="cover-reposition-cancel" onClick={() => setReposition(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : cover ? (
        <div className="page-cover-actions">
          {cover.kind === "url" ? (
            <button type="button" className="page-cover-button" data-testid="cover-save-to-vault" disabled={saving} onClick={() => void saveToVault()}>
              {t("cover.saveToVault")}
            </button>
          ) : null}
          <button
            type="button"
            className="page-cover-button"
            data-testid="cover-change"
            aria-expanded={pickerOpen}
            aria-haspopup="dialog"
            onClick={() => setPickerOpen((open) => !open)}
          >
            {t("cover.change")}
          </button>
          {image && attempt < 2 && look.coverSource === "cover" ? (
            <button type="button" className="page-cover-button" data-testid="cover-reposition" onClick={() => setReposition(look.position)}>
              {t("cover.reposition")}
            </button>
          ) : null}
          <button type="button" className="page-cover-button" data-testid="cover-remove" onClick={() => void remove()}>
            {look.coverSource === "banner" ? t("cover.hide") : t("cover.remove")}
          </button>
        </div>
      ) : null}

      {look.coverSource === "banner" && cover ? (
        <span className="page-cover-source" data-testid="cover-from-banners">
          {t("cover.fromBanners")}
        </span>
      ) : null}
      {error ? (
        <p className="page-cover-error" role="alert">
          {error}
        </p>
      ) : null}

      {pickerOpen ? (
        <CoverPicker
          current={cover}
          onPick={(next) => void set(next)}
          onClose={() => setPickerOpen(false)}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

type Tab = "gallery" | "upload" | "vault" | "link";

/** The images matching the search (name or folder), in the server's order. */
const shown = (images: VaultImage[], query: string) => {
  const needle = query.trim().toLowerCase();
  return needle ? images.filter((item) => item.path.toLowerCase().includes(needle)) : images;
};

interface CoverPickerProps {
  current: Cover | null;
  onPick: (cover: Cover) => void;
  onClose: () => void;
  onError: (message: string) => void;
}

function CoverPicker({ current, onPick, onClose, onError }: CoverPickerProps) {
  const [tab, setTab] = useState<Tab>("gallery");
  const [images, setImages] = useState<VaultImage[] | null>(null);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (tab !== "vault" || images !== null) return;
    api
      .listImages()
      .then(setImages)
      .catch((caught: unknown) => {
        setImages([]);
        onError(errorMessage(caught));
      });
  }, [tab, images, onError]);

  const run = async (task: () => Promise<Attachment>) => {
    setBusy(true);
    try {
      const attachment = await task();
      onPick({ kind: "image", link: attachment.path });
    } catch (caught) {
      onError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const isCurrent = (cover: Cover) => current !== null && coverValue(current) === coverValue(cover);
  const tabs: Array<[Tab, string]> = [
    ["gallery", t("cover.gallery")],
    ["upload", t("cover.upload")],
    ["vault", t("cover.vault")],
    ["link", t("cover.link")],
  ];

  return (
    <div className="cover-picker" ref={ref} role="dialog" aria-label={t("cover.pickerLabel")} data-testid="cover-picker">
      <div className="cover-picker-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`cover-picker-tab${tab === id ? " is-active" : ""}`}
            data-testid={`cover-tab-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "gallery" ? (
        <div className="cover-picker-body">
          <p className="cover-picker-heading">{t("cover.colors")}</p>
          <div className="cover-swatches">
            {PAGE_COLORS.map((name) => {
              const cover: Cover = { kind: "color", name };
              return (
                <button
                  key={name}
                  type="button"
                  className={`cover-swatch${isCurrent(cover) ? " is-current" : ""}`}
                  data-testid={`cover-color-${name}`}
                  aria-label={t(`format.colors.${name}`)}
                  data-tooltip={t(`format.colors.${name}`)}
                  style={{ background: coverFill(name) }}
                  onClick={() => onPick(cover)}
                />
              );
            })}
          </div>
          <p className="cover-picker-heading">{t("cover.gradients")}</p>
          <div className="cover-swatches">
            {PAGE_GRADIENTS.map((name: PageGradient) => {
              const cover: Cover = { kind: "gradient", name };
              return (
                <button
                  key={name}
                  type="button"
                  className={`cover-swatch cover-gradient-${name}${isCurrent(cover) ? " is-current" : ""}`}
                  data-testid={`cover-gradient-${name}`}
                  aria-label={t(`cover.gradientNames.${name}`)}
                  data-tooltip={t(`cover.gradientNames.${name}`)}
                  onClick={() => onPick(cover)}
                />
              );
            })}
          </div>
        </div>
      ) : tab === "upload" ? (
        <div className="cover-picker-body">
          <label className="button-secondary cover-upload">
            {busy ? t("cover.uploading") : t("cover.chooseImage")}
            <input
              type="file"
              accept="image/*"
              className="visually-hidden"
              data-testid="cover-upload-input"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void run(() => api.uploadAttachment(file));
              }}
            />
          </label>
          <p className="cover-picker-note">{t("cover.uploadHint")}</p>
        </div>
      ) : tab === "vault" ? (
        <div className="cover-picker-body">
          {images !== null && images.length > SEARCH_FROM ? (
            <input
              className="cover-link-input cover-vault-search"
              data-testid="cover-vault-search"
              type="search"
              value={query}
              placeholder={t("cover.searchImages")}
              aria-label={t("cover.searchImages")}
              onChange={(event) => setQuery(event.target.value)}
            />
          ) : null}
          {images === null ? null : images.length === 0 ? (
            <p className="cover-picker-note">{t("cover.noImages")}</p>
          ) : (
            <div className="cover-vault-grid">
              {shown(images, query).map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className="cover-vault-item"
                  data-testid={`cover-vault-${item.path}`}
                  aria-label={item.path}
                  data-tooltip={item.path}
                  onClick={() => onPick({ kind: "image", link: item.path })}
                >
                  <img src={fileUrl(item.path)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <form
          className="cover-picker-body"
          onSubmit={(event) => {
            event.preventDefault();
            const value = url.trim();
            if (value) void run(() => api.importAttachment(value));
          }}
        >
          <input
            className="cover-link-input"
            data-testid="cover-link-input"
            type="url"
            value={url}
            placeholder={t("cover.linkPlaceholder")}
            aria-label={t("cover.link")}
            onChange={(event) => setUrl(event.target.value)}
          />
          <button type="submit" className="button-primary" disabled={busy || url.trim().length === 0}>
            {busy ? t("cover.saving") : t("cover.saveLink")}
          </button>
          <p className="cover-picker-note">{t("cover.linkHint")}</p>
        </form>
      )}
    </div>
  );
}
