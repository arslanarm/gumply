/**
 * Tool errors (spec/mcp §3): a tool result with `isError: true` and
 * `structuredContent: { error: { code, message, … } }`. JSON-RPC errors are
 * left to the SDK for protocol problems.
 */
import type { CallToolResult } from "@modelcontextprotocol/server";
import { VaultError } from "../../server/src/errors.js";

export type ErrorCode =
  | "NOT_FOUND"
  | "AMBIGUOUS"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "WRITES_DISABLED"
  | "OUTSIDE_VAULT"
  | "UNSUPPORTED"
  | "TOO_LARGE"
  | "RATE_LIMITED"
  | "INTERNAL";

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function errorResult(error: unknown): CallToolResult {
  const known = toToolError(error);
  const payload = { code: known.code, message: known.message, ...known.extra };
  return {
    isError: true,
    content: [{ type: "text", text: `${known.code}: ${known.message}` }],
    structuredContent: { error: payload },
  };
}

function toToolError(error: unknown): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof VaultError) {
    const code: ErrorCode =
      error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : error.status === 413 ? "TOO_LARGE" : "INVALID_INPUT";
    return new ToolError(code, error.message);
  }
  // Never echo internals (paths, stacks) to the client; they go to stderr.
  console.error("[gumply mcp] unexpected error:", error);
  return new ToolError("INTERNAL", "Something went wrong reading the vault; see the server log.");
}
