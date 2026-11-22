/**
 * The vault's linkable files for the `![[` menu (#4usgpjh8), per note: each
 * carries the link text Obsidian would write from that note. Loaded when a
 * page opens and refreshed after an upload; the menu reads it synchronously
 * (an empty list until the first answer arrives).
 */
import type { LinkableFile } from "@gumply/core";
import { api } from "../api/client.js";

let loadedFor: string | null = null;
let files: LinkableFile[] = [];
let generation = 0;

/** Fetch the list for note `pageId` (again, when `force`). */
export function loadLinkableFiles(pageId: string, force = false): void {
  if (!pageId || (!force && loadedFor === pageId)) return;
  loadedFor = pageId;
  const mine = ++generation;
  api
    .listLinkableFiles(pageId)
    .then((list) => {
      if (mine === generation) files = list;
    })
    .catch(() => {
      if (mine === generation) files = [];
    });
}

/** The list for note `pageId`, or empty while it isn't loaded. */
export function linkableFiles(pageId: string): readonly LinkableFile[] {
  return loadedFor === pageId ? files : [];
}
