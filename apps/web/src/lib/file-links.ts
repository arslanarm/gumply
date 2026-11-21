/**
 * Obsidian-style file links in the app (#8k4ssrkb, spec/api-attachments-resolve).
 *
 * A node keeps its link exactly as written (`obsidian`: `![[pic.png|100]]`);
 * where it points is worked out when it's shown, from the note that holds it:
 * the page or board payload's `fileLinks`, else (a link typed after load) one
 * `GET /files/resolve`, cached per (note, link) for the session. So a link
 * pasted into a page in another folder resolves for that folder, and no
 * resolved URL is ever written back into a file.
 */
import { useSyncExternalStore } from "react";
import { api, fileUrl } from "../api/client.js";

/** `![[pic.png|100]]` / `[[att/report.pdf#p=2]]` → `pic.png` / `att/report.pdf`. */
export function obsidianLinkOf(obsidian: string | null | undefined): string | null {
  if (!obsidian) return null;
  const match = /^!?\[\[([^\]]*)\]\]$/.exec(obsidian.trim());
  if (!match) return null;
  const link = (match[1] ?? "").split("|")[0]!.split("#")[0]!.trim();
  return link || null;
}

const cache = new Map<string, string | null>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const keyOf = (from: string, link: string) => `${from}\u0000${link.toLowerCase()}`;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/**
 * The vault path `link` resolves to from note `from`: `known` (the payload's
 * `fileLinks`) first, then the session cache. `undefined` while it's being
 * asked for (a re-render follows).
 */
export function resolvedFileLink(
  link: string,
  from: string,
  known?: Record<string, string | null> | null,
): string | null | undefined {
  if (known && Object.hasOwn(known, link)) return known[link] ?? null;
  const key = keyOf(from, link);
  if (cache.has(key)) return cache.get(key) ?? null;
  if (!pending.has(key)) {
    pending.add(key);
    void api
      .resolveFileLink(link, from)
      .then((path) => cache.set(key, path))
      .catch(() => cache.set(key, null))
      .finally(() => {
        pending.delete(key);
        notify();
      });
  }
  return undefined;
}

/** The same, as a promise (DOM code outside React). */
export async function resolveFileLinkAsync(
  link: string,
  from: string,
  known?: Record<string, string | null> | null,
): Promise<string | null> {
  const now = resolvedFileLink(link, from, known);
  if (now !== undefined) return now;
  return new Promise((resolve) => {
    const check = () => {
      const value = resolvedFileLink(link, from, known);
      if (value === undefined) return;
      listeners.delete(check);
      resolve(value);
    };
    listeners.add(check);
  });
}

/** Call `listener` when a link typed after load has been resolved. */
export function subscribeFileLinks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-render when a link typed after load has been resolved. */
export function useFileLinkVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version,
  );
}

/** The `/api/files` URL for an Obsidian link (null: no such file; undefined: still asking). */
export function obsidianFileUrl(
  obsidian: string | null | undefined,
  from: string,
  known?: Record<string, string | null> | null,
): string | null | undefined {
  const link = obsidianLinkOf(obsidian);
  if (!link) return null;
  const path = resolvedFileLink(link, from, known);
  return path === undefined ? undefined : path === null ? null : fileUrl(path);
}
