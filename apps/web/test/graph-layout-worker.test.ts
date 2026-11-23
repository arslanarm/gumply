import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutInputFor } from "../src/graph/layout-forces";

/**
 * #3jep576p (found by @opus-editor in #xb4b54gr): layout-client cancels a run
 * by posting `stop` with that run's id. The worker used to take the stop's id
 * as the current run, so the cancelled run went on to its end, keeping the
 * worker busy with a layout nobody wanted.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Posted = { type: string; id: number; done?: boolean };

async function worker() {
  const posted: Posted[] = [];
  const fake: { postMessage: (message: Posted) => void; onmessage?: (event: { data: unknown }) => void } = {
    postMessage: (message) => posted.push(message),
  };
  vi.stubGlobal("self", fake);
  await import("../src/graph/layout-worker");
  return { posted, send: (data: unknown) => fake.onmessage!({ data }) };
}

/** A streamed graph big enough to take many slices (positions are posted as it goes). */
function input() {
  const nodes = Array.from({ length: 1_200 }, (_, i) => ({ id: `n${i}` }));
  const links = nodes.flatMap((node, i) => [
    { source: node.id, target: `n${(i + 1) % nodes.length}` },
    { source: node.id, target: `n${(i * 7 + 3) % nodes.length}` },
  ]);
  return layoutInputFor(nodes, links, { centerId: null, width: 1200, height: 800, reducedMotion: false });
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the layout worker's stop (#3jep576p)", () => {
  it("a stop ends the run it names: nothing is posted after it, and it never reaches done", async () => {
    const { posted, send } = await worker();
    send({ type: "start", id: 7, input: input() });
    send({ type: "stop", id: 7 });
    const atStop = posted.length;
    await settle(300);
    expect(posted.length).toBe(atStop);
    expect(posted.some((message) => message.done)).toBe(false);
  });

  it("a stop for an older run doesn't stop the newer one", async () => {
    const { posted, send } = await worker();
    send({ type: "start", id: 1, input: input() });
    send({ type: "start", id: 2, input: input() });
    send({ type: "stop", id: 1 });
    await vi.waitFor(() => expect(posted.some((message) => message.id === 2 && message.done)).toBe(true), { timeout: 30_000, interval: 50 });
    expect(posted.some((message) => message.id === 1 && message.done)).toBe(false);
  }, 40_000);
});
