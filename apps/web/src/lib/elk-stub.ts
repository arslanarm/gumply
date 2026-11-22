/**
 * v0.8 F2: stands in for `elkjs/lib/elk.bundled.js` (aliased in
 * vite.config.ts). elkjs is EPL-2.0 / GPL-3.0, which Gumply doesn't ship, so
 * Mermaid's ELK layout isn't available: the config pins `layout: "dagre"`,
 * and a diagram that still reaches for ELK gets a plain error instead.
 */
export default class ElkUnavailable {
  layout(): Promise<never> {
    return Promise.reject(new Error("The ELK layout isn't available in Gumply; Mermaid's default layout is used."));
  }
}
