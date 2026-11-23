/**
 * #g95wkd9y (spec/api v1.32): the graph's links as index pairs into `nodes`.
 *
 * On a 10,000-note vault `GET /graph` is 14 MB, 11 MB of it links: every link
 * spells out two page ids, which are paths. With `?links=index` each link is
 * `[sourceIndex, targetIndex]`, a few bytes however long the paths are. The
 * default payload is unchanged (API and MCP clients); the web app asks for
 * this form and expands it (the ids it rebuilds are the node ids already in
 * memory, so no new strings are made).
 */
import type { GraphData, PageId } from "./types.js";

export interface IndexedGraphData extends Omit<GraphData, "links"> {
  links: Array<[number, number]>;
  linkFormat: "index";
}

/** The server side: links as indexes into `nodes` (a link to a node not listed is dropped). */
export function indexGraphLinks(data: GraphData): IndexedGraphData {
  const index = new Map<PageId, number>();
  data.nodes.forEach((node, i) => index.set(node.id, i));
  const links: Array<[number, number]> = [];
  for (const link of data.links) {
    const source = index.get(link.source);
    const target = index.get(link.target);
    if (source !== undefined && target !== undefined) links.push([source, target]);
  }
  return { ...data, links, linkFormat: "index" };
}

/** The client side: back to `{ source, target }` ids (a pair out of range is dropped). */
export function expandGraphLinks(data: IndexedGraphData | GraphData): GraphData {
  if (!("linkFormat" in data) || data.linkFormat !== "index") return data as GraphData;
  const { linkFormat: _format, links, ...rest } = data;
  const nodes = data.nodes;
  const expanded: GraphData["links"] = [];
  for (const [source, target] of links) {
    const from = nodes[source];
    const to = nodes[target];
    if (from && to) expanded.push({ source: from.id, target: to.id });
  }
  return { ...rest, links: expanded };
}
