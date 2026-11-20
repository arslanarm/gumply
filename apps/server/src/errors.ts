/** Errors that map directly onto API responses. */
export type VaultErrorStatus = 400 | 404 | 409 | 413 | 422;

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
