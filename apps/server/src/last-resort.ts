/**
 * #35q6kt6e: the last-resort net for promise rejections nothing handled.
 *
 * Node ends the process on an unhandled rejection. For Gumply that means the
 * local server goes away ("Can't reach Gumply's local server"), and in the
 * desktop app the whole server inside the window's process. Every path we know
 * of handles its own errors (the watcher's rescans, history timers, imports);
 * this catches any we missed: it logs the reason, loudly, and keeps running.
 * It never swallows silently.
 */
const installed = new WeakSet<object>();

type RejectionTarget = Pick<NodeJS.EventEmitter, "on" | "off">;

export function logUnhandledRejections(
  log: (message: string, reason: unknown) => void = (message, reason) => console.error(message, reason),
  target: RejectionTarget = process,
): () => void {
  if (installed.has(target)) return () => {};
  installed.add(target);
  const handler = (reason: unknown) => log("[gumply] unhandled rejection (kept running):", reason);
  target.on("unhandledRejection", handler);
  return () => {
    target.off("unhandledRejection", handler);
    installed.delete(target);
  };
}
