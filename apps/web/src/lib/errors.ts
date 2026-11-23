/** Friendly error copy for the UI (spec/ux §12). */
import { ApiRequestError } from "../api/client.js";
import { t } from "../i18n/index.js";

/** "Can't reach Gumply's local server." in the current language. */
export function serverDownMessage(): string {
  return t("errors.serverDown");
}

/**
 * Never leak raw HTTP status text (e.g. "Internal Server Error") into the UI.
 * 5xx responses and network failures both mean the local server is down.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status >= 500) return serverDownMessage();
    return error.message;
  }
  if (error instanceof Error) {
    if (/fetch|network|load failed|failed to fetch/i.test(error.message)) {
      return serverDownMessage();
    }
    return error.message;
  }
  return t("errors.generic");
}

/**
 * #2xx3uae4: only a real 404 from a server that answered means a page doesn't
 * exist. A failed fetch, a timeout or a 5xx (the dev server's proxy answers 5xx
 * while the local server is down) means it couldn't be reached.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 404;
}
