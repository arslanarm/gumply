/**
 * Small store shared by the wiki-link node views and the `[[` suggestion.
 * A React context would not reach `ReactNodeViewRenderer` (it mounts in its
 * own root), so node views subscribe here instead.
 */
import type { Attachment, PageMeta } from "@gumply/core";
import { useSyncExternalStore } from "react";

export interface WikiLinkEnvironment {
  /** Id (vault path) of the open page: attachment links are relative to it (D23). */
  pageId: string;
  pages: readonly PageMeta[];
  attachments: readonly Attachment[];
  /** #8k4ssrkb: the open page's Obsidian file links, resolved by the server. */
  fileLinks?: Readonly<Record<string, string | null>>;
  /** `from`: the page the link is written in, when it isn't the open page (a preview's own links, #35e42m7v). */
  openLink: (link: { targetTitle: string; heading: string; from?: string }) => void;
  createLink: (title: string) => void;
  /** Show an error in the page's action banner (e.g. "Save to vault" failed). */
  reportError?: (message: string) => void;
  /** A new file landed in attachments/ (keeps link resolution current). */
  addAttachment?: (attachment: Attachment) => void;
}

const noop = () => {};

let environment: WikiLinkEnvironment = {
  pageId: "",
  pages: [],
  attachments: [],
  openLink: noop,
  createLink: noop,
};

const listeners = new Set<() => void>();

export function setWikiLinkEnvironment(next: WikiLinkEnvironment): void {
  environment = next;
  // Notify outside React's lifecycle: TipTap node views flush synchronously,
  // which React warns about when triggered straight from an effect.
  queueMicrotask(() => {
    for (const listener of listeners) listener();
  });
}

export function getWikiLinkEnvironment(): WikiLinkEnvironment {
  return environment;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Imperative subscription for the DOM-based node view. */
export const subscribeWikiLinkEnvironment = subscribe;

export function useWikiLinkEnvironment(): WikiLinkEnvironment {
  return useSyncExternalStore(subscribe, getWikiLinkEnvironment, getWikiLinkEnvironment);
}
