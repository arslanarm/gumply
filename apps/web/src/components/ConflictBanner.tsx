import { useEffect, useState } from "react";
import type { ConflictCopy, ConflictKeep, PageMeta } from "@gumply/core";
import { api } from "../api/client.js";
import { useT } from "../i18n/index.js";
import { conflictTime, conflictToolName } from "../lib/conflicts.js";
import type { CompareTarget } from "./ConflictCompareDialog.js";
import { orphanTitle } from "./ConflictsView.js";
import { Icon } from "./Icon.js";

export interface ConflictBannerProps {
  /** The open page, board or base. */
  meta: PageMeta;
  refreshKey: number;
  onCompare: (target: CompareTarget) => void;
  onShowAll: () => void;
  onResolve: (copy: ConflictCopy, keep: ConflictKeep) => Promise<void>;
}

/**
 * D43 / spec/sync-conflicts §4.1: above a page that has conflict copies, a
 * status line with Compare (the newest copy) and More… (the Conflicts list).
 * On an orphan copy (its original gone): Keep as the original / Delete copy.
 * Never modal, no close button: it goes away when the conflict is resolved.
 */
export function ConflictBanner({ meta, refreshKey, onCompare, onShowAll, onResolve }: ConflictBannerProps) {
  const t = useT();
  const [copies, setCopies] = useState<ConflictCopy[]>([]);
  const [busy, setBusy] = useState(false);
  const orphan = meta.conflictOf === null;

  useEffect(() => {
    let live = true;
    api.conflicts().then(
      (list) => {
        if (!live) return;
        setCopies(list.copies.filter((copy) => (orphan ? copy.copyId === meta.id : copy.originalId === meta.id)));
      },
      () => live && setCopies([]),
    );
    return () => {
      live = false;
    };
  }, [meta.id, meta.conflicts, orphan, refreshKey]);

  if (copies.length === 0) return null;
  const run = async (copy: ConflictCopy, keep: ConflictKeep) => {
    setBusy(true);
    try {
      await onResolve(copy, keep);
    } finally {
      setBusy(false);
    }
  };

  if (orphan) {
    const copy = copies[0]!;
    return (
      <div className="banner conflict-banner" role="status" data-testid="conflict-banner">
        <Icon name="alert" size={16} />
        <span>{t("conflicts.orphan")}</span>
        <span className="conflict-banner-actions">
          <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-banner-keep-as" onClick={() => void run(copy, "as-original")}>
            {t("conflicts.keepAs", { title: orphanTitle(copy) })}
          </button>
          <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-banner-delete" onClick={() => void run(copy, "delete")}>
            {t("conflicts.deleteCopy")}
          </button>
        </span>
      </div>
    );
  }

  // The newest copy first (the tool's own times sort as text).
  const newest = [...copies].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))[0]!;
  const time = conflictTime(newest.at);
  const message =
    copies.length > 1
      ? t("conflicts.bannerMany", { count: copies.length })
      : newest.device && time
        ? t("conflicts.bannerOne", { device: newest.device, date: time })
        : t("conflicts.bannerOneUnknown", { tool: conflictToolName(newest.tool) });
  return (
    <div className="banner conflict-banner" role="status" data-testid="conflict-banner">
      <Icon name="alert" size={16} />
      <span>{message}</span>
      <span className="conflict-banner-actions">
        {newest.same ? (
          <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-banner-remove" onClick={() => void run(newest, "delete")}>
            {t("conflicts.removeCopy")}
          </button>
        ) : (
          <button type="button" className="button-secondary" data-testid="conflict-banner-compare" onClick={() => onCompare({ copy: newest })}>
            {t("conflicts.compare")}
          </button>
        )}
        <button type="button" className="button-secondary" data-testid="conflict-banner-more" onClick={onShowAll}>
          {t("conflicts.more")}
        </button>
      </span>
    </div>
  );
}

export interface ConflictCopyBannerProps {
  meta: PageMeta;
  pages: readonly PageMeta[];
  refreshKey: number;
  onCompare: (target: CompareTarget) => void;
  onResolve: (copy: ConflictCopy, keep: ConflictKeep) => Promise<void>;
}

/** §4.1: on a copy opened from search or a link: read-only, with Compare / Keep this copy / Delete copy. */
export function ConflictCopyBanner({ meta, pages, refreshKey, onCompare, onResolve }: ConflictCopyBannerProps) {
  const t = useT();
  const [copy, setCopy] = useState<ConflictCopy | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.conflicts().then(
      (list) => live && setCopy(list.copies.find((item) => item.copyId === meta.id) ?? null),
      () => live && setCopy(null),
    );
    return () => {
      live = false;
    };
  }, [meta.id, refreshKey]);

  const originalTitle = pages.find((page) => page.id === meta.conflictOf)?.title ?? meta.conflictOf ?? "";
  const time = conflictTime(copy?.at);
  const tool = copy ? conflictToolName(copy.tool) : "";
  const run = async (keep: ConflictKeep) => {
    if (!copy) return;
    setBusy(true);
    try {
      await onResolve(copy, keep);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner conflict-banner" role="status" data-testid="conflict-copy-banner">
      <Icon name="alert" size={16} />
      <span>
        {time ? t("conflicts.copyBanner", { title: originalTitle, tool, date: time }) : t("conflicts.copyBannerNoDate", { title: originalTitle, tool })}{" "}
        <span className="conflict-banner-note">{t("conflicts.readOnly")}</span>
      </span>
      {copy ? (
        <span className="conflict-banner-actions">
          <button type="button" className="button-secondary" data-testid="conflict-copy-compare" onClick={() => onCompare({ copy })}>
            {t("conflicts.compare")}
          </button>
          <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-copy-keep" onClick={() => void run("copy")}>
            {t("conflicts.keepCopy")}
          </button>
          {copy.same ? (
            <button type="button" className="button-secondary" disabled={busy} data-testid="conflict-copy-delete" onClick={() => void run("delete")}>
              {t("conflicts.deleteCopy")}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
