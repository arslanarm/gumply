/** Errors that map directly onto API responses. */
export type VaultErrorStatus = 400 | 404 | 409 | 413 | 422 | 423;

export class VaultError extends Error {
  constructor(
    readonly status: VaultErrorStatus,
    message: string,
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
