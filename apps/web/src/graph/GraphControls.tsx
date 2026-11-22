/**
 * E1: the graph's control panel, like Obsidian's: Filters (tags,
 * attachments, existing files only, orphans) and colour Groups (a query and
 * a colour each, in order: the first match wins).
 */
import type { GraphFilters, GraphGroup, GraphSettings } from "@gumply/core";
import { useState } from "react";
import { Icon } from "../components/Icon.js";
import { useT, type MessageKey } from "../i18n/index.js";
import { FALLBACK_GRAPH_PALETTE } from "./graph-model.js";
import { nextGroupColor } from "./graph-settings.js";

export interface GraphControlsProps {
  settings: GraphSettings;
  onChange: (next: GraphSettings) => void;
  onClose: () => void;
}

type FilterFlag = Exclude<keyof GraphFilters, "search">;

const FLAGS: Array<{ key: FilterFlag; label: MessageKey }> = [
  { key: "showTags", label: "graph.panel.showTags" },
  { key: "showAttachments", label: "graph.panel.showAttachments" },
  { key: "hideUnresolved", label: "graph.panel.existingOnly" },
  { key: "showOrphans", label: "graph.panel.showOrphans" },
];

export function GraphControls({ settings, onChange, onClose }: GraphControlsProps) {
  const t = useT();
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [groupsOpen, setGroupsOpen] = useState(true);

  const setFlag = (key: FilterFlag, value: boolean) => onChange({ ...settings, filters: { ...settings.filters, [key]: value } });
  const setGroups = (groups: GraphGroup[]) => onChange({ ...settings, groups });
  const editGroup = (index: number, patch: Partial<GraphGroup>) =>
    setGroups(settings.groups.map((group, at) => (at === index ? { ...group, ...patch } : group)));
  const moveGroup = (index: number, by: number) => {
    const groups = [...settings.groups];
    const [group] = groups.splice(index, 1);
    groups.splice(index + by, 0, group!);
    setGroups(groups);
  };
  const addGroup = () =>
    setGroups([...settings.groups, { query: "", color: nextGroupColor(settings.groups.map((group) => group.color), FALLBACK_GRAPH_PALETTE) }]);

  return (
    <aside className="graph-panel" data-testid="graph-controls" aria-label={t("graph.panel.title")}>
      <div className="graph-panel-head">
        <p className="graph-panel-title">{t("graph.panel.title")}</p>
        <button type="button" className="graph-panel-close" aria-label={t("graph.panel.close")} data-tooltip={t("graph.panel.close")} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      <section className="graph-panel-section">
        <button type="button" className="graph-panel-section-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
          <span className={`graph-panel-chevron${filtersOpen ? " is-open" : ""}`} aria-hidden="true">›</span>
          {t("graph.panel.filters")}
        </button>
        {filtersOpen ? (
          <div className="graph-panel-body">
            {FLAGS.map((flag) => (
              <label key={flag.key} className="graph-panel-toggle">
                <span>{t(flag.label)}</span>
                <input
                  type="checkbox"
                  role="switch"
                  data-testid={`graph-filter-${flag.key}`}
                  checked={settings.filters[flag.key]}
                  onChange={(event) => setFlag(flag.key, event.target.checked)}
                />
              </label>
            ))}
          </div>
        ) : null}
      </section>

      <section className="graph-panel-section">
        <button type="button" className="graph-panel-section-toggle" aria-expanded={groupsOpen} onClick={() => setGroupsOpen((open) => !open)}>
          <span className={`graph-panel-chevron${groupsOpen ? " is-open" : ""}`} aria-hidden="true">›</span>
          {t("graph.panel.groups")}
        </button>
        {groupsOpen ? (
          <div className="graph-panel-body">
            {settings.groups.length === 0 ? <p className="graph-panel-hint">{t("graph.panel.noGroups")}</p> : null}
            <datalist id="graph-group-colors">
              {FALLBACK_GRAPH_PALETTE.map((color) => (
                <option key={color} value={color} />
              ))}
            </datalist>
            {settings.groups.map((group, index) => (
              <div key={index} className="graph-group-row" data-testid="graph-group">
                <input
                  type="color"
                  className="graph-group-color"
                  list="graph-group-colors"
                  aria-label={t("graph.panel.groupColor")}
                  value={group.color}
                  onChange={(event) => editGroup(index, { color: event.target.value.toLowerCase() })}
                />
                <input
                  type="text"
                  className="graph-group-query"
                  data-testid="graph-group-query"
                  spellCheck={false}
                  placeholder={t("graph.panel.groupQuery")}
                  aria-label={t("graph.panel.groupQueryLabel")}
                  value={group.query}
                  onChange={(event) => editGroup(index, { query: event.target.value })}
                />
                <button type="button" className="graph-group-button" aria-label={t("graph.panel.moveUp")} data-tooltip={t("graph.panel.moveUp")} disabled={index === 0} onClick={() => moveGroup(index, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="graph-group-button"
                  aria-label={t("graph.panel.moveDown")}
                  data-tooltip={t("graph.panel.moveDown")}
                  disabled={index === settings.groups.length - 1}
                  onClick={() => moveGroup(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="graph-group-button"
                  aria-label={t("graph.panel.removeGroup")}
                  data-tooltip={t("graph.panel.removeGroup")}
                  onClick={() => setGroups(settings.groups.filter((_, at) => at !== index))}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="button-secondary graph-group-add" data-testid="graph-group-add" onClick={addGroup}>
              <Icon name="plus" size={14} /> {t("graph.panel.newGroup")}
            </button>
            <p className="graph-panel-hint">{t("graph.panel.groupsHint")}</p>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
