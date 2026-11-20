/**
 * Small store shared by the wiki-link node views and the `[[` suggestion.
 * A React context would not reach `ReactNodeViewRenderer` (it mounts in its
 * own root), so node views subscribe here instead.
 */
import type { Attachment, PageMeta } from "@gumply/core";
import { useSyncExternalStore } from "react";

export interface WikiLinkEnvironment {
  pages: readonly PageMeta[];
  attachments: readonly Attachment[];
  openLink: (link: { targetTitle: string; heading: string }) => void;
  createLink: (title: string) => void;
}

const noop = () => {};

let environment: WikiLinkEnvironment = {
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
