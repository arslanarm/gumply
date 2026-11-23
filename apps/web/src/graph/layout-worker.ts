/// <reference lib="webworker" />
/**
 * #g95wkd9y: the big graph's layout, off the main thread. Runs the shared
 * layout (layout-forces.ts) in slices and posts positions about every 100 ms
 * (with reduced motion: once, when it has settled). A newer `start` or a
 * `stop` abandons the current run.
 */
import { createLayout, postInterval, type LayoutInput } from "./layout-forces.js";

export type LayoutRequest = { type: "start"; id: number; input: LayoutInput } | { type: "stop"; id: number };
export type LayoutUpdate =
  | { type: "positions"; id: number; x: Float32Array; y: Float32Array; done: boolean; ticks: number }
  /** Not streaming (a big graph, or reduced motion): how far along the layout is, 0–1. */
  | { type: "progress"; id: number; progress: number; done: false };

const PROGRESS_EVERY_MS = 500;

const SLICE_MS = 40;


let current = 0;

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;
  // #3jep576p: a stop names the run it cancels (layout-client). It used to set
  // `current` to that same id, so the cancelled run went on to its end (CPU busy
  // with a layout nobody wants). Abandon it, unless a newer run already took over.
  if (message.type === "stop") {
    if (current === message.id) current = -1;
    return;
  }
  current = message.id;
  const { id, input } = message;
  const layout = createLayout(input);
  const postEvery = postInterval(input.x.length);
  let lastPost = 0;
  const post = (done: boolean) => {
    const { x, y } = layout.positions();
    const update: LayoutUpdate = { type: "positions", id, x, y, done, ticks: layout.ticks };
    (self as unknown as Worker).postMessage(update, [x.buffer, y.buffer]);
  };
  const slice = () => {
    if (current !== id) return; // A newer run (or a stop) took over.
    const until = performance.now() + SLICE_MS;
    let done = false;
    while (!done && performance.now() < until) done = layout.tick();
    const now = performance.now();
    if (done) return post(true);
    if (input.stream && now - lastPost >= postEvery) {
      lastPost = now;
      post(false);
    } else if (!input.stream && now - lastPost >= PROGRESS_EVERY_MS) {
      lastPost = now;
      const update: LayoutUpdate = { type: "progress", id, progress: layout.progress(), done: false };
      (self as unknown as Worker).postMessage(update);
    }
    // Yield, so a newer start or a stop is seen between slices.
    setTimeout(slice, 0);
  };
  slice();
};
