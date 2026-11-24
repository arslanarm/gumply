import { afterEach, describe, expect, it, vi } from "vitest";
import { computeClusters } from "../src/graph/clusters";

/**
 * #xb4b54gr: big graphs in links mode cluster in the layout worker (Louvain
 * takes ~0.3–0.5 s at 10k): the worker posts the same clusters the main
 * thread would compute, before its first layout update.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("clusters in the layout worker", () => {
  it("posts the clusters first, equal to the main thread's, and uses them for the force", async () => {
    const posted: Array<{ type: string; [key: string]: unknown }> = [];
    const fakeSelf: { postMessage: (message: never) => void; onmessage?: (event: { data: unknown }) => void } = {
      postMessage: (message) => posted.push(message),
    };
    vi.stubGlobal("self", fakeSelf);
    await import("../src/graph/layout-worker");

    // Three groups of 20, dense inside; plus a ghost node that is never clustered.
    const ids = [...Array.from({ length: 60 }, (_, i) => `p${String(i).padStart(2, "0")}`), "\u0001ghost"];
    const pairs: number[] = [];
    for (let i = 0; i < 60; i += 1) for (let j = i + 1; j < 60; j += 1) if (Math.floor(i / 20) === Math.floor(j / 20) && (i + j) % 3 !== 0) pairs.push(i, j);
    pairs.push(0, 20, 20, 40, 5, 60);
    const clusterable = Uint8Array.from(ids, (id) => (id.startsWith("\u0001") ? 0 : 1));
    const input = {
      x: new Float32Array(ids.length).fill(Number.NaN),
      y: new Float32Array(ids.length).fill(Number.NaN),
      links: Uint32Array.from(pairs),
      pinned: -1,
      chargeStrength: -60,
      centerStrengthX: 0.12,
      centerStrengthY: 0.12,
      reducedMotion: true,
      stream: false,
      clusterLinks: { ids, clusterable },
    };
    fakeSelf.onmessage!({ data: { type: "start", id: 7, input } });
    fakeSelf.onmessage!({ data: { type: "stop", id: 7 } });

    expect(posted[0]?.type).toBe("clusters");
    const fromWorker = posted[0] as unknown as { of: Int32Array; list: Array<{ size: number }> };
    const links: Array<{ source: string; target: string }> = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) links.push({ source: ids[pairs[i]!]!, target: ids[pairs[i + 1]!]! });
    const onMain = computeClusters(
      "links",
      ids.map((id, i) => ({ id, clusterable: clusterable[i] === 1, parentId: null, tags: [] })),
      links,
    );
    expect([...fromWorker.of]).toEqual([...onMain.of]);
    // The stop names run 7, and the run ends there: nothing more is posted (it used to run on to the end).
    const atStop = posted.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(posted.length).toBe(atStop);
    expect(fromWorker.list.map((info) => info.size)).toEqual([20, 20, 20]);
    expect(fromWorker.of[60]).toBe(-1);
  });
});
