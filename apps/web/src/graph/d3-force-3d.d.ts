/**
 * The parts of d3-force-3d (force-graph's layout engine, MIT) that the layout
 * worker uses (#g95wkd9y). The package ships no types; its API is d3-force's.
 */
declare module "d3-force-3d" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Chain = any;
  export function forceSimulation(nodes?: unknown[], dimensions?: number): Chain;
  export function forceLink(links?: unknown[]): Chain;
  export function forceManyBody(): Chain;
  export function forceX(x?: number): Chain;
  export function forceY(y?: number): Chain;
}
