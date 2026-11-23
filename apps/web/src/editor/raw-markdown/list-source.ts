/**
 * Keep an untouched list's bytes (#fmmght8w).
 *
 * The editor models lists as nodes; their Markdown details were lost on the
 * way in, so saving any change rewrote lists the user never touched:
 *
 * - ordered numbers: `1.` / `10.` became `1.` / `2.`, and ` 9.` / `10.`
 *   padding was guessed;
 * - an upper-case `[X]` became `[x]`;
 * - one tight list mixing plain and to-do items is two editor lists (bullet
 *   and task), written with a blank line between them; a loose one lost
 *   blank lines because each half guessed its own tightness.
 *
 * A core rule records what the source says on each list item, and the nodes
 * keep it as attributes (never copied to a new item on Enter):
 *
 * - `data-md-number`: the item's number as written, with the spaces before
 *   it (relative padding is worked out when writing);
 * - `data-md-check`: `X` for an upper-case check;
 * - `data-md-gap`: blank lines before the item, used when splitting a mixed
 *   list (see markdown-task-list-fix).
 *
 * And on a list: `data-md-after-text` when it starts right under a line of
 * text with no blank line (a nested list under its item's text, even in a
 * loose list).
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export const NUMBER_ATTR = "data-md-number";
export const CHECK_ATTR = "data-md-check";
export const GAP_ATTR = "data-md-gap";
/** On the second half of a split list: a blank line separated the halves. */
/* Not `data-md-join`: that's the block-join stamp (#54prcupx), and sharing
 * the name made the list split drop it (#q7ajxdr4). */
export const LOOSE_JOIN_ATTR = "data-md-loose-join";
export const AFTER_TEXT_ATTR = "data-md-after-text";

const LIST_OPEN = new Set(["bullet_list_open", "ordered_list_open"]);

/* markdown-it is untyped here (see wikilink plugin). */
/* eslint-disable @typescript-eslint/no-explicit-any */

/** Blank once quote markers are set aside (a `>` line inside a quote). */
const isBlank = (line: string | undefined) => line !== undefined && /^[ \t>]*$/.test(line);

export function listSourceRule(state: any): void {
  const lines = String(state.src).split("\n");
  const tokens = state.tokens as any[];
  tokens.forEach((token, index) => {
    if (LIST_OPEN.has(token.type) && token.map && tokens[index - 1]?.type === "paragraph_close") {
      if (!isBlank(lines[(token.map[0] as number) - 1])) token.attrSet(AFTER_TEXT_ATTR, "true");
      return;
    }
    if (token.type !== "list_item_open" || !token.map) return;
    const first = token.map[0] as number;
    let gap = 0;
    while (first - gap - 1 >= 0 && isBlank(lines[first - gap - 1])) gap += 1;
    if (gap > 0) token.attrSet(GAP_ATTR, String(gap));

    const line = lines[first] ?? "";
    if (/^\d+$/.test(String(token.info ?? "")) && (token.markup === "." || token.markup === ")")) {
      const marker = `${token.info}${token.markup}`;
      const at = line.indexOf(marker);
      if (at >= 0) {
        const pad = /[ \t]*$/.exec(line.slice(0, at))?.[0] ?? "";
        // Tabs before a number are rare; leave such lists to renumbering.
        if (!pad.includes("\t")) token.attrSet(NUMBER_ATTR, `${pad}${token.info}`);
      }
    }

    const inline = tokens[index + 2];
    const paragraph = tokens[index + 1]?.type === "paragraph_open" && inline?.type === "inline";
    // An empty task: `- [ ] ` with its trailing space is a task in Obsidian
    // (without the space it's a bullet reading "[ ]"). markdown-it trims the
    // line, so markdown-it-task-lists would miss it: give the space back
    // (#54prcupx).
    if (paragraph && /^\[[ xX]\]$/.test(inline.content) && /\[[ xX]\][ \t]+$/.test(line)) {
      inline.content = `${inline.content} `;
    }
    if (paragraph && /^\[X\][ \t]/.test(inline.content)) {
      token.attrSet(CHECK_ATTR, "X");
    }
  });
}

/** Item attributes, and the loose-join mark on bullet/task lists. */
export const MarkdownListSource = Extension.create({
  name: "markdownListSource",
  addGlobalAttributes() {
    return [
      {
        types: ["listItem"],
        attributes: {
          markdownNumber: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute(NUMBER_ATTR),
            renderHTML: () => ({}),
          },
        },
      },
      {
        types: ["taskItem"],
        attributes: {
          markdownCheck: {
            default: null,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => (element.getAttribute(CHECK_ATTR) === "X" ? "X" : null),
            renderHTML: () => ({}),
          },
        },
      },
      {
        types: ["bulletList", "taskList", "orderedList"],
        attributes: {
          markdownAfterText: {
            default: false,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute(AFTER_TEXT_ATTR) === "true",
            renderHTML: () => ({}),
          },
        },
      },
      {
        types: ["bulletList", "taskList"],
        attributes: {
          markdownLooseJoin: {
            default: false,
            keepOnSplit: false,
            parseHTML: (element: HTMLElement) => element.getAttribute(LOOSE_JOIN_ATTR) === "loose",
            renderHTML: () => ({}),
          },
        },
      },
    ];
  },
});

/**
 * The numbers to write for an ordered list: as recorded when every item has
 * one, they never fall, and the first is the list's start; otherwise null
 * (renumber).
 */
export function recordedNumbers(node: PMNode, start: number): string[] | null {
  const recorded: string[] = [];
  node.forEach((child) => {
    const value = child.attrs.markdownNumber;
    if (typeof value === "string") recorded.push(value);
  });
  if (recorded.length !== node.childCount || recorded.length === 0) return null;
  const values = recorded.map((value) => Number(value.trim()));
  if (values[0] !== start) return null;
  // Never falling: equal neighbours are kept as written (`1.` `1.` `1.`, or an item dropped in
  // with its neighbour's number, #2kafk39m), as CommonMark renders them in sequence anyway.
  for (let i = 1; i < values.length; i += 1) if (!(values[i]! >= values[i - 1]!)) return null;
  // Keep padding relative to the least-indented number.
  const least = Math.min(...recorded.map((value) => value.length - value.trimStart().length));
  return recorded.map((value) => value.slice(least));
}
