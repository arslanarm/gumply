/**
 * `![[Tasks.base]]` / `![[Tasks.base#Board]]` in a page (D34, spec/api-bases):
 * the view itself, live and editable, with `this` = the page it sits in (so
 * "pages linking here" works). It loads once the embed is near the viewport
 * and reloads when the base file or any page changes.
 */
import { resolveWikilink, type PageMeta } from "@gumply/core";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, type BaseDocument } from "../api/client.js";
import { BaseView } from "../bases/BaseView.js";
import { useWikiLinkEnvironment } from "../editor/wikilink/link-store.js";
import { isBase } from "../lib/bases.js";
import { errorMessage } from "../lib/errors.js";
import { useT } from "../i18n/index.js";
import { useNearViewport } from "./BoardEmbedView.js";
import { Icon } from "./Icon.js";

function stampOf(pages: readonly PageMeta[]): string {
  let hash = 0;
  for (const item of pages) {
    const text = `${item.id}\u0000${item.updated}`;
    for (let i = 0; i < text.length; i += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0;
  }
  return `${pages.length}:${hash}`;
}

export function BaseEmbedView({ node, selected }: NodeViewProps) {
  const t = useT();
  const target = String(node.attrs.target ?? "");
  const viewName = String(node.attrs.view ?? "");
  const env = useWikiLinkEnvironment();
  const frameRef = useRef<HTMLDivElement | null>(null);
  const near = useNearViewport(frameRef);
  const resolved = resolveWikilink(target, env.pages, env.pageId);
  const base = resolved && isBase(resolved) ? resolved : null;
  const stamp = useMemo(() => stampOf(env.pages), [env.pages]);

  const [doc, setDoc] = useState<{ id: string; doc: BaseDocument | null; error: string | null }>({ id: "", doc: null, error: null });
  const id = base?.id ?? "";
  const updated = base?.updated ?? "";
  useEffect(() => {
    if (!near || !id) return;
    let cancelled = false;
    api
      .getBase(id)
      .then((loaded) => {
        if (!cancelled) setDoc({ id, doc: loaded, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setDoc({ id, doc: null, error: errorMessage(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [near, id, updated]);

  const open = (pageId: string) => env.openLink({ targetTitle: pageId, heading: "" });
  const title = base?.title ?? (target.split("/").pop() ?? target).replace(/\.base$/i, "");

  return (
    <NodeViewWrapper
      className={`base-embed${selected ? " is-selected" : ""}${base ? "" : " is-missing"}`}
      data-testid="base-embed"
      data-target={target}
      contentEditable={false}
    >
      <div ref={frameRef} className="base-embed-frame">
        <div className="base-embed-bar">
          <span className="base-embed-title" data-testid="base-embed-title">
            <Icon name="database" size={15} />
            <span>{title}</span>
            {viewName ? <span className="base-embed-view">{viewName}</span> : null}
          </span>
          {base ? (
            <button
              type="button"
              className="base-embed-open"
              data-testid="base-embed-open"
              aria-label={t("bases.embedOpen", { title })}
              onClick={() => open(base.id)}
            >
              {t("common.open")}
            </button>
          ) : null}
        </div>
        {!base ? (
          <div className="base-embed-missing" data-testid="base-embed-missing">
            {t("bases.embedNotFound")}
          </div>
        ) : doc.doc && doc.id === id ? (
          <BaseView
            key={id}
            baseId={id}
            initial={doc.doc}
            pages={env.pages}
            refreshKey={stamp}
            onOpen={open}
            onError={env.reportError}
            embed={{ thisId: env.pageId, ...(viewName ? { viewName } : {}), maxRows: 10 }}
          />
        ) : doc.error ? (
          <div className="base-embed-missing">{t("bases.loadFailed", { error: doc.error })}</div>
        ) : (
          <div className="base-loading" aria-busy="true" />
        )}
      </div>
    </NodeViewWrapper>
  );
}
