/**
 * E1: the graph's colour groups and filters, loaded once per graph view and
 * saved (debounced) to `.gumply/graph.json` through the API. A pending save
 * is sent when the view closes, so leaving right after a change keeps it.
 */
import { DEFAULT_GRAPH_SETTINGS, normalizeGraphSettings, type GraphSettings } from "@gumply/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client.js";

export const SAVE_DELAY_MS = 400;

export interface GraphSettingsState {
  /** Null until loaded (the graph waits, so its first layout uses them). */
  settings: GraphSettings | null;
  update: (next: GraphSettings) => void;
}

export function useGraphSettings(): GraphSettingsState {
  const [settings, setSettings] = useState<GraphSettings | null>(null);
  const pending = useRef<GraphSettings | null>(null);
  /**
   * #xb4b54gr: "Group by" is sent only once the user changes it here, so a
   * value this Gumply doesn't know (from a newer one) stays in the file.
   */
  const clusterByTouched = useRef(false);
  const current = useRef<GraphSettings | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getGraphSettings()
      .then((loaded) => {
        if (!live) return;
        const normalized = normalizeGraphSettings(loaded);
        current.current = normalized;
        setSettings(normalized);
      })
      .catch(() => {
        // The graph still works with the defaults; a later change saves them.
        if (!live) return;
        current.current = DEFAULT_GRAPH_SETTINGS;
        setSettings(DEFAULT_GRAPH_SETTINGS);
      });
    return () => {
      live = false;
    };
  }, []);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    const { clusterBy, ...rest } = next;
    void api.putGraphSettings(clusterByTouched.current ? { ...rest, clusterBy } : rest).catch(() => undefined);
  }, []);

  useEffect(() => flush, [flush]);

  const update = useCallback(
    (next: GraphSettings) => {
      if (current.current && next.clusterBy !== current.current.clusterBy) clusterByTouched.current = true;
      current.current = next;
      setSettings(next);
      pending.current = next;
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
    },
    [flush],
  );

  return { settings, update };
}

/** The next group's default colour: the first theme colour no group uses yet. */
export function nextGroupColor(used: readonly string[], palette: readonly string[]): string {
  const taken = new Set(used.map((color) => color.toLowerCase()));
  return palette.find((color) => !taken.has(color.toLowerCase())) ?? palette[used.length % palette.length] ?? "#2f5f8f";
}
