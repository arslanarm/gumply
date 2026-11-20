/** Errors that map directly onto API responses. */
export type VaultErrorStatus = 400 | 404 | 409 | 413;

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
