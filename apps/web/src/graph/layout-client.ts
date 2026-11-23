/**
 * #g95wkd9y: the main thread's side of the layout worker. One worker per
 * page, created on first use; each run has an id, so positions from an older
 * run (the data or a filter changed since) are dropped.
 */
import type { LayoutInput } from "./layout-forces.js";
import type { LayoutRequest, LayoutUpdate } from "./layout-worker.js";

let worker: Worker | null = null;
let nextId = 1;
const listeners = new Map<number, (update: LayoutUpdate) => void>();

function layoutWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./layout-worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (event: MessageEvent<LayoutUpdate>) => {
    const listener = listeners.get(event.data.id);
    if (!listener) return;
    if (event.data.done) listeners.delete(event.data.id);
    listener(event.data);
  };
  return worker;
}

/**
 * Lay out `input` in the worker; `onUpdate` gets positions as they come and
 * once more with `done`. Returns a cancel function (also stops the worker's
 * run, so a superseded layout doesn't keep the CPU busy).
 */
export function startLayout(input: LayoutInput, onUpdate: (update: LayoutUpdate) => void): () => void {
  const target = layoutWorker();
  const id = nextId++;
  listeners.set(id, onUpdate);
  const request: LayoutRequest = { type: "start", id, input };
  target.postMessage(request, [input.x.buffer, input.y.buffer, input.links.buffer]);
  return () => {
    if (!listeners.delete(id)) return;
    const stop: LayoutRequest = { type: "stop", id };
    target.postMessage(stop);
  };
}
