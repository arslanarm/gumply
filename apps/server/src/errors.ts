/** Errors that map directly onto API responses. */
export type VaultErrorStatus = 400 | 404 | 409 | 413 | 422 | 423;

export class VaultError extends Error {
  constructor(
    readonly status: VaultErrorStatus,
    message: string,
    /** A machine-readable cause the client says in its own words (#hazfav7a: "name-taken"). */
    readonly reason?: string,
    /** The title the reason is about. */
    readonly title?: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export function badRequest(message: string): VaultError {
  return new VaultError(400, message);
}

export function notFound(message: string): VaultError {
  return new VaultError(404, message);
}

export function conflict(message: string): VaultError {
  return new VaultError(409, message);
}

/**
 * #hazfav7a: a rename to a name another page, board, database or folder has here (any letter case). Refused before
 * anything is written; the client says it in the user's language from `reason` and `title`.
 */
export function nameTaken(title: string): VaultError {
  // Kind-neutral: a page, board, database or folder may hold the name (@opus-editor).
  return new VaultError(409, `“${title}” is already used here`, "name-taken", title);
}

export function payloadTooLarge(message: string): VaultError {
  return new VaultError(413, message);
}

/**
 * A remote download failed or sent something unusable (#w6i6e6u7). Not 502:
 * the web client reads 5xx as "the local server is down" (a dev proxy says
 * 502 when it is).
 */
export function unprocessable(message: string): VaultError {
  return new VaultError(422, message);
}

/**
 * #bajn9rna: the file is read-only on disk (its permissions, set by the user or
 * another tool). Gumply respects that: nothing is written, and the client keeps
 * the text and tries again once the file is writable. 423 Locked, so it reads
 * apart from a conflict (409) and from "the server is down" (5xx).
 */
export function readOnly(message: string): VaultError {
  return new VaultError(423, message);
}
