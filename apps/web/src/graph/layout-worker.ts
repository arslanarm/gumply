/// <reference lib="webworker" />
/**
 * #g95wkd9y: the big graph's layout, off the main thread. Runs the shared
 * layout (layout-forces.ts) in slices and posts positions about every 100 ms
 * (with reduced motion: once, when it has settled). A newer `start` or a
 * `stop` abandons the current run.
 */
import { createLayout, postInterval, type LayoutInput } from "./layout-forces.js";

export type LayoutRequest = { type: "start"; id: number; input: LayoutInput } | { type: "stop"; id: number };
export type LayoutUpdate = { type: "positions"; id: number; x: Float32Array; y: Float32Array; done: boolean; ticks: number };

const SLICE_MS = 40;


let current = 0;

self.onmessage = (event: MessageEvent<LayoutRequest>) => {
  const message = event.data;
  current = message.id;
  if (message.type === "stop") return;
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
    if (!input.reducedMotion && now - lastPost >= postEvery) {
      lastPost = now;
      post(false);
    }
    // Yield, so a newer start or a stop is seen between slices.
    setTimeout(slice, 0);
  };
  slice();
};
