/**
 * The right-hand column (v0.8 D1): Outline | Local graph tabs, as in
 * Obsidian. Which tab is open (or none) is a per-device preference.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../i18n/index.js";

export type RightPanelTab = "outline" | "graph";

const KEY = "gumply:right-panel";
const OLD_SESSION_KEY = "gumply:local-graph";

/** The stored choice; an open local graph from before v0.8 (session only) opens on Graph once. */
export function readRightPanel(): RightPanelTab | null {
  try {
    const stored = localStorage.getItem(KEY);
    let old: string | null = null;
    try {
      old = sessionStorage.getItem(OLD_SESSION_KEY);
    } catch {
      // Session storage is optional.
    }
    if (stored === "outline" || stored === "graph") return stored;
    if (stored === null && old === "open") return "graph";
    return null;
  } catch {
    return null;
  }
}

/** Saves the choice; the pre-v0.8 session key has been read by then and goes. */
export function writeRightPanel(tab: RightPanelTab | null): void {
  try {
    sessionStorage.removeItem(OLD_SESSION_KEY);
  } catch {
    // Session storage is optional.
  }
  try {
    if (tab) localStorage.setItem(KEY, tab);
    else localStorage.setItem(KEY, "closed");
  } catch {
    // Local storage is optional.
  }
}

export function RightPanel(props: {
  tab: RightPanelTab;
  onTab: (tab: RightPanelTab) => void;
  onClose: () => void;
  outline: ReactNode;
  graph: ReactNode;
}) {
  const t = useT();
  const tabs: { id: RightPanelTab; label: string }[] = [
    { id: "outline", label: t("panel.tabOutline") },
    { id: "graph", label: t("panel.tabGraph") },
  ];
  const listRef = useRef<HTMLDivElement | null>(null);
  // ←/→ move between the tabs (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next = tabs[(tabs.findIndex((tab) => tab.id === props.tab) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]!;
    props.onTab(next.id);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-tab="${next.id}"]`)?.focus());
  };
  return (
    <aside className="right-panel" aria-label={t("panel.label")} data-testid="right-panel">
      <div className="right-panel-header">
        <div className="right-panel-tabs" role="tablist" ref={listRef} onKeyDown={onKeyDown}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`right-panel-tab-${tab.id}`}
              aria-controls="right-panel-body"
              aria-selected={props.tab === tab.id}
              tabIndex={props.tab === tab.id ? 0 : -1}
              data-tab={tab.id}
              data-testid={`right-panel-tab-${tab.id}`}
              className={`right-panel-tab${props.tab === tab.id ? " is-active" : ""}`}
              onClick={() => props.onTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="icon-button right-panel-close"
          data-testid="right-panel-close"
          aria-label={t("panel.close")}
          data-tooltip={t("panel.close")}
          onClick={props.onClose}
        >
          ×
        </button>
      </div>
      <div className="right-panel-body" id="right-panel-body" role="tabpanel" aria-labelledby={`right-panel-tab-${props.tab}`}>
        {props.tab === "outline" ? props.outline : props.graph}
      </div>
    </aside>
  );
}
