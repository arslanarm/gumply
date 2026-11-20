#!/usr/bin/env node
/**
 * Regenerates apps/web/src/lib/emoji/emoji-data.json from `emojibase-data`
 * (MIT). Run after bumping emojibase-data: `npm run emoji:data`.
 *
 * Output is a compact array of rows so the lazily loaded chunk stays small:
 *   [emoji, name, keywords (space separated), shortcodes (space separated),
 *    category index, emoji version]
 * Skin-tone variants and the "component" group (bare skin tones, hair styles)
 * are left out; regional-indicator letters are dropped too.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const data = require("emojibase-data/en/data.json");
const github = require("emojibase-data/en/shortcodes/github.json");
const emojibase = require("emojibase-data/en/shortcodes/emojibase.json");

// Must match CATEGORY_IDS in apps/web/src/lib/emoji/data.ts.
// emojibase groups: 0 smileys, 1 people, 2 component, 3 animals, 4 food,
// 5 travel, 6 activities, 7 objects, 8 symbols, 9 flags.
const GROUP_TO_CATEGORY = { 0: 0, 1: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8 };

const asList = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

const rows = data
  .filter((entry) => entry.group !== undefined && entry.group in GROUP_TO_CATEGORY)
  .filter((entry) => !/^regional indicator/i.test(entry.label))
  .sort((a, b) => a.order - b.order)
  .map((entry) => {
    const name = entry.label.toLowerCase();
    const keywords = [...new Set(asList(entry.tags).map((tag) => tag.toLowerCase()))]
      .filter((tag) => tag !== name)
      .join(" ");
    const shortcodes = [
      ...new Set([...asList(github[entry.hexcode]), ...asList(emojibase[entry.hexcode])]),
    ].join(" ");
    return [entry.emoji, name, keywords, shortcodes, GROUP_TO_CATEGORY[entry.group], entry.version];
  });

const out = fileURLToPath(new URL("../apps/web/src/lib/emoji/emoji-data.json", import.meta.url));
const json = `[\n${rows.map((row) => JSON.stringify(row)).join(",\n")}\n]\n`;
const previous = (() => {
  try {
    return readFileSync(out, "utf8");
  } catch {
    return "";
  }
})();
writeFileSync(out, json);
console.log(`${rows.length} emoji → ${out}${previous === json ? " (unchanged)" : ""}`);
