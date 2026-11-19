/** Friendly error copy for the UI (spec/ux §12). */
import { ApiRequestError } from "../api/client.js";

export const SERVER_DOWN_MESSAGE = "Can't reach Gumply's local server.";

/**
 * Never leak raw HTTP status text (e.g. "Internal Server Error") into the UI.
 * 5xx responses and network failures both mean the local server is down.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status >= 500) return SERVER_DOWN_MESSAGE;
    return error.message;
  }
  if (error instanceof Error) {
    if (/fetch|network|load failed|failed to fetch/i.test(error.message)) {
      return SERVER_DOWN_MESSAGE;
    }
    return error.message;
  }
  return "Something went wrong.";
}
