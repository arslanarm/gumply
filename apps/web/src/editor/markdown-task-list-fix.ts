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
