/**
 * markdown-it merges a bullet list and a following to-do list into one
 * `<ul class="contains-task-list">` when they are separated by a blank line
 * (CommonMark keeps them in the same loose list). tiptap-markdown then marks
 * the whole list as a taskList, mixing task and normal items, which TipTap
 * parses into an extra empty to-do plus two lists (Q1 audit follow-up
 * #gd2cpx2c).
 *
 * Split such mixed lists back into their natural runs: ordinary items become a
 * bullet list, task items become a task list, in source order. Runs after the
 * built-in taskList/taskItem `updateDOM` (lower extension priority).
 */
import { Extension } from "@tiptap/core";
import { AFTER_TEXT_ATTR, GAP_ATTR, LOOSE_JOIN_ATTR } from "./raw-markdown/list-source.js";

function isTaskItem(item: Element): boolean {
  return item.getAttribute("data-type") === "taskItem";
}

function splitList(list: Element): void {
  const items = [...list.children].filter((child) => child.tagName === "LI");
  const tasks = items.filter(isTaskItem);
  if (tasks.length === 0 || tasks.length === items.length) return;

  const groups: Array<{ task: boolean; items: Element[] }> = [];
  for (const item of items) {
    const task = isTaskItem(item);
    const last = groups[groups.length - 1];
    if (last && last.task === task) last.items.push(item);
    else groups.push({ task, items: [item] });
  }

  const fragment = list.ownerDocument.createDocumentFragment();
  for (const group of groups) {
    const clone = list.cloneNode(false) as HTMLElement;
    if (group.task) {
      clone.setAttribute("data-type", "taskList");
      clone.classList.add("contains-task-list");
    } else {
      clone.removeAttribute("data-type");
      clone.classList.remove("contains-task-list");
    }
    for (const item of group.items) clone.appendChild(item);
    // A group is tight when its items are single paragraphs with no blank
    // line between them in the source (#fmmght8w); a blank line before the
    // group's first item is kept as a loose join to the previous group.
    const single = group.items.every((item) => item.querySelectorAll(":scope > p").length <= 1);
    const gapless = group.items.slice(1).every((item) => !item.hasAttribute(GAP_ATTR));
    if (single && gapless) clone.setAttribute("data-tight", "true");
    else clone.removeAttribute("data-tight");
    if (group !== groups[0] && group.items[0]!.hasAttribute(GAP_ATTR)) clone.setAttribute(LOOSE_JOIN_ATTR, "loose");
    else clone.removeAttribute(LOOSE_JOIN_ATTR);
    // Only the first half can sit right under a line of text.
    if (group !== groups[0]) clone.removeAttribute(AFTER_TEXT_ATTR);
    fragment.appendChild(clone);
  }
  list.replaceWith(fragment);
}

/** Split every mixed normal/task list in the parsed HTML, deepest first. */
export function splitMixedTaskLists(root: Element): void {
  const lists = [...root.querySelectorAll("ul, ol")].reverse();
  for (const list of lists) splitList(list);
}

export const MarkdownTaskListFix = Extension.create({
  name: "markdownTaskListFix",
  // Runs after the node extensions' markdown updateDOM (priority 100).
  priority: 10,

  addStorage() {
    return {
      markdown: {
        parse: {
          updateDOM: (element: Element) => splitMixedTaskLists(element),
        },
      },
    };
  },
});

/**
 * tiptap-markdown only gives bullet/ordered lists the `tight` attribute, so a
 * to-do list was always written as a loose list (`- [ ] a\n\n- [ ] b`): every
 * save added blank lines between to-dos. Give task lists the same attribute,
 * with the same parse rule (tight unless the items hold `<p>`).
 */
export const TaskListTight = Extension.create({
  name: "taskListTight",

  addGlobalAttributes() {
    return [
      {
        types: ["taskList"],
        attributes: {
          tight: {
            default: true,
            parseHTML: (element: HTMLElement) =>
              element.getAttribute("data-tight") === "true" || !element.querySelector("p"),
            renderHTML: (attributes: { tight?: boolean }) => ({
              class: attributes.tight ? "tight" : null,
              "data-tight": attributes.tight ? "true" : null,
            }),
          },
        },
      },
    ];
  },
});
