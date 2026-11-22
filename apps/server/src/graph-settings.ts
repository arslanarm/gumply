/**
 * Graph view settings (v0.8 E1, spec/api-graph-groups): `.gumply/graph.json`.
 *
 * Without it, a vault Obsidian set up starts from `.obsidian/graph.json`
 * (colour groups, search and the four filters), read on each `GET` until the
 * first `PUT` writes `.gumply/graph.json`. Gumply never writes `.obsidian/`.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_GRAPH_SETTINGS,
  fromObsidianGraph,
  normalizeGraphSettings,
  type GraphSettings,
  type GraphSettingsResponse,
} from "@gumply/core";
import { badRequest } from "./errors.js";
import { writeAtomic } from "./temp-files.js";

const GUMPLY_FILE = join(".gumply", "graph.json");
const OBSIDIAN_FILE = join(".obsidian", "graph.json");

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export async function readGraphSettings(root: string): Promise<GraphSettingsResponse> {
  const own = await readJson(join(root, GUMPLY_FILE));
  // An unreadable or invalid file falls back like a missing one, so a typo can't break the graph.
  if (own !== undefined && typeof own === "object" && own !== null && !Array.isArray(own)) {
    return { ...normalizeGraphSettings(own), source: "gumply" };
  }
  const obsidian = await readJson(join(root, OBSIDIAN_FILE));
  if (obsidian !== undefined && typeof obsidian === "object" && obsidian !== null && !Array.isArray(obsidian)) {
    return { ...fromObsidianGraph(obsidian), source: "obsidian" };
  }
  return { ...DEFAULT_GRAPH_SETTINGS, source: "default" };
}

/** Validate a `PUT` body and save it to `.gumply/graph.json` (atomic). */
export async function writeGraphSettings(root: string, body: unknown): Promise<GraphSettingsResponse> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw badRequest("Expected { groups, filters }");
  const { groups, filters } = body as { groups?: unknown; filters?: unknown };
  if (groups !== undefined && !Array.isArray(groups)) throw badRequest("groups must be a list");
  if (filters !== undefined && (typeof filters !== "object" || filters === null || Array.isArray(filters))) {
    throw badRequest("filters must be an object");
  }
  const settings: GraphSettings = normalizeGraphSettings(body);
  const dir = join(root, ".gumply");
  await mkdir(dir, { recursive: true });
  const file = join(root, GUMPLY_FILE);
  await writeAtomic(file, `${JSON.stringify(settings, null, 2)}\n`);
  return { ...settings, source: "gumply" };
}
