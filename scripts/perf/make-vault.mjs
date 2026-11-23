#!/usr/bin/env node
/**
 * A large, reproducible vault for the performance budget (#g95wkd9y,
 * dev/performance-budget). Writes files directly; no server needed.
 *
 *   node scripts/perf/make-vault.mjs <dir> [--notes 10000] [--seed 1] [--board 1000]
 *
 * Deterministic by seed: the same arguments give the same bytes (no dates
 * from the clock, no Math.random). The target folder must not exist yet.
 *
 * What's in it (all synthetic):
 * - <notes> Markdown notes in 20 areas × 10 topics (even areas have a folder
 *   page `Area NN.md`, odd ones are plain folders, D33), titles from a word list;
 * - bodies of 80-400 words with headings, lists, a code block now and then;
 * - links: 4-14 per note to other notes, some `[[x|alias]]`, `[[x#Heading]]`,
 *   `![[x]]` embeds, and ~5% to notes that don't exist (ghosts);
 * - a hub note "Hub" linked from ~20% of notes and mentioned without a link in
 *   ~30% (backlinks and unlinked mentions under load);
 * - inline `#tags` (60 tags, some nested) and frontmatter on ~60% of notes:
 *   tags, status, due, priority, done, related: "[[x]]";
 * - `.obsidian/types.json`, 24 images under attachments/ referenced by ~10%;
 * - 5 `.base` views and 5 boards: four of 60 objects, one of <board> objects
 *   (stickies, text, page cards, 0.6×N connectors).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith("--"));
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const NOTES = option("notes", 10_000);
const SEED = option("seed", 1);
const BOARD = option("board", 1000);
if (!dir || !Number.isInteger(NOTES) || NOTES < 10 || !Number.isInteger(BOARD) || BOARD < 10) {
  console.error("usage: node scripts/perf/make-vault.mjs <dir> [--notes 10000] [--seed 1] [--board 1000]");
  process.exit(2);
}
if (existsSync(dir)) {
  console.error(`${dir} exists; pick a new folder`);
  process.exit(2);
}

/** mulberry32: a small seeded PRNG, so every run writes the same vault. */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(SEED);
const int = (n) => Math.floor(random() * n);
const pick = (list) => list[int(list.length)];
const chance = (p) => random() < p;

const WORDS = (
  "river garden lantern orbit maple quiet copper meadow signal harbor velvet ember canyon pixel thunder willow " +
  "beacon prism cobalt drift falcon glacier hollow island jasmine kettle lumen marble nectar oasis pepper quartz " +
  "raven saffron tundra umbra violet walnut yonder zephyr anchor basil cedar delta echo fable granite horizon " +
  "indigo juniper kelp lattice mosaic nimbus onyx parcel quill ribbon sierra timber utopia vertex wander xylo " +
  "plan review draft budget roadmap meeting notes research summary design sprint backlog launch retro idea"
).split(" ");
const TAGS = Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? `area/${WORDS[i]}` : `${WORDS[(i * 7) % WORDS.length]}-${i}`));
const STATUS = ["todo", "doing", "done", "blocked", "someday"];

const sentence = (min, max) => {
  const n = min + int(max - min + 1);
  const words = Array.from({ length: n }, () => pick(WORDS));
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return `${words.join(" ")}.`;
};
const iso = (dayOffset) => new Date(Date.UTC(2026, 0, 1) + dayOffset * 86_400_000).toISOString().slice(0, 10);

// --- layout: titles and folders ---------------------------------------------
const AREAS = 20;
const TOPICS = 10;
const notes = [];
const seen = new Set();
for (let i = 0; i < NOTES; i++) {
  let title;
  do title = `${pick(WORDS)} ${pick(WORDS)} ${i}`.replace(/^./, (c) => c.toUpperCase());
  while (seen.has(title.toLowerCase()));
  seen.add(title.toLowerCase());
  const area = i % AREAS;
  const topic = Math.floor(i / AREAS) % TOPICS;
  notes.push({ title, folder: `Area ${String(area).padStart(2, "0")}/Topic ${topic}`, headings: [] });
}
notes[0].title = "Hub";
notes[0].folder = "";

// --- write -----------------------------------------------------------------------
const write = (path, text) => {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
mkdirSync(dir, { recursive: true });

// Folder pages for even areas (D20 layout); odd areas stay plain folders (D33).
for (let area = 0; area < AREAS; area += 2) {
  const name = `Area ${String(area).padStart(2, "0")}`;
  write(`${name}.md`, `# ${name}\n\n${sentence(8, 20)}\n`);
}

// Images: a valid 1×1 PNG each (the bytes don't matter, the references do).
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const IMAGES = Array.from({ length: 24 }, (_, i) => `img-${String(i).padStart(2, "0")}.png`);
for (const name of IMAGES) write(`attachments/${name}`, PNG);

write(
  ".obsidian/types.json",
  `${JSON.stringify({ types: { status: "text", due: "date", priority: "number", done: "checkbox", related: "text", tags: "tags" } }, null, 2)}\n`,
);

// Pass 1: headings per note (so `[[x#Heading]]` points at real headings).
for (const note of notes) {
  const count = 1 + int(4);
  for (let h = 0; h < count; h++) note.headings.push(`${pick(WORDS)} ${pick(WORDS)}`.replace(/^./, (c) => c.toUpperCase()));
}

let links = 0;
let dangling = 0;
for (let i = 0; i < notes.length; i++) {
  const note = notes[i];
  const lines = [];
  if (chance(0.6)) {
    const tags = Array.from({ length: 1 + int(3) }, () => pick(TAGS));
    lines.push(
      "---",
      `tags: [${[...new Set(tags)].join(", ")}]`,
      `status: ${pick(STATUS)}`,
      `due: ${iso(int(400))}`,
      `priority: ${1 + int(5)}`,
      `done: ${chance(0.3)}`,
      ...(chance(0.3) ? [`related: "[[${pick(notes).title}]]"`] : []),
      "---",
      "",
    );
  }
  const linkCount = 4 + int(11);
  const paragraphs = [];
  for (let p = 0; p < 3 + int(6); p++) {
    let text = Array.from({ length: 2 + int(4) }, () => sentence(6, 16)).join(" ");
    // Links woven into the prose.
    const parts = [];
    for (let l = 0; l < Math.ceil(linkCount / 4); l++) {
      links++;
      if (chance(0.05)) {
        dangling++;
        parts.push(`[[Missing ${int(NOTES * 2)}]]`);
        continue;
      }
      const target = notes[int(notes.length)];
      const r = random();
      if (r < 0.15) parts.push(`[[${target.title}|${pick(WORDS)}]]`);
      else if (r < 0.25) parts.push(`[[${target.title}#${pick(target.headings)}]]`);
      else parts.push(`[[${target.title}]]`);
    }
    if (chance(0.5)) parts.push(`#${pick(TAGS)}`);
    text += ` See ${parts.join(", ")}.`;
    paragraphs.push(text);
  }
  if (i > 0 && chance(0.2)) paragraphs.push(`Linked to the [[Hub]] for the overview.`);
  if (i > 0 && chance(0.3)) paragraphs.push(`The Hub keeps the overview of everything.`);
  if (chance(0.05)) paragraphs.push(`![[${pick(notes).title}]]`);
  if (chance(0.1)) paragraphs.push(`![[${pick(IMAGES)}]]`);
  const body = [];
  note.headings.forEach((heading, h) => {
    body.push(`## ${heading}`, "", paragraphs[h % paragraphs.length], "");
    if (h === 0 && chance(0.3)) body.push(...Array.from({ length: 2 + int(4) }, () => `- ${sentence(3, 8)}`), "");
    if (h === 1 && chance(0.1)) body.push("```js", `const ${pick(WORDS)} = ${int(1000)};`, "```", "");
  });
  for (const extra of paragraphs.slice(note.headings.length)) body.push(extra, "");
  const path = note.folder ? `${note.folder}/${note.title}.md` : `${note.title}.md`;
  write(path, `${[...lines, ...body].join("\n").trimEnd()}\n`);
}

// Database views (Obsidian Bases).
for (let b = 0; b < 5; b++) {
  write(
    `Views/View ${b}.base`,
    [
      "filters:",
      "  and:",
      `    - file.hasTag("${TAGS[b * 6]}")`,
      "views:",
      "  - type: table",
      `    name: Table ${b}`,
      "    order:",
      "      - file.name",
      "      - status",
      "      - due",
      "      - priority",
      "",
    ].join("\n"),
  );
}

// Boards: four of 60 objects and one of BOARD objects.
function board(objects) {
  const nodes = [];
  const edges = [];
  const columns = Math.ceil(Math.sqrt(objects));
  for (let n = 0; n < objects; n++) {
    const x = (n % columns) * 280;
    const y = Math.floor(n / columns) * 200;
    const id = `n${n}`;
    if (n % 10 === 0) nodes.push({ id, type: "file", file: `${notes[int(notes.length)].folder}/${notes[int(notes.length)].title}.md`.replace(/^\//, ""), x, y, width: 240, height: 160 });
    else if (n % 3 === 0) nodes.push({ id, type: "text", text: `### ${sentence(2, 4)}\n${sentence(5, 12)} [[${pick(notes).title}]]`, x, y, width: 240, height: 160, color: String(1 + int(6)) });
    else nodes.push({ id, type: "text", text: sentence(4, 14), x, y, width: 220, height: 120 });
  }
  for (let e = 0; e < Math.floor(objects * 0.6); e++) {
    const from = int(objects);
    const to = int(objects);
    if (from === to) continue;
    edges.push({ id: `e${e}`, fromNode: `n${from}`, toNode: `n${to}`, ...(e % 5 === 0 ? { label: pick(WORDS) } : {}) });
  }
  return `${JSON.stringify({ nodes, edges }, null, "\t")}\n`;
}
for (let b = 0; b < 4; b++) write(`Boards/Board ${b}.canvas`, board(60));
write(`Boards/Big board.canvas`, board(BOARD));

console.log(
  JSON.stringify({ dir, seed: SEED, notes: NOTES, links, dangling, tags: TAGS.length, images: IMAGES.length, bases: 5, boards: 5, bigBoard: BOARD }),
);
