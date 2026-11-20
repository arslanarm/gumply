import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { describe, expect, it } from "vitest";
import { taskShortcutReplacement } from "../src/editor/task-shortcut.js";

const schema = getSchema([StarterKit, TaskList, TaskItem]);
const bulletListType = schema.nodes.bulletList!;
const listItemType = schema.nodes.listItem!;
const taskListType = schema.nodes.taskList!;
const taskItemType = schema.nodes.taskItem!;
const paragraphType = schema.nodes.paragraph!;

function bulletList(...texts: string[]) {
  return bulletListType.create(
    null,
    texts.map((text) => listItemType.create(null, paragraphType.create(null, schema.text(text)))),
  );
}

describe("taskShortcutReplacement", () => {
  it("turns a lone bullet into a to-do list", () => {
    const { nodes, cursorOffset } = taskShortcutReplacement({
      list: bulletList("milk"),
      taskListType,
      taskItemType,
      paragraphType,
      index: 0,
      checked: false,
    });

    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.type.name).toBe("taskList");
    expect(nodes[0]!.child(0).type.name).toBe("taskItem");
    expect(nodes[0]!.child(0).attrs.checked).toBe(false);
    // to-do list open + item open + paragraph open.
    expect(cursorOffset).toBe(3);
  });

  it("keeps sibling bullets on both sides of the new to-do", () => {
    const list = bulletList("before", "to do", "after");
    const { nodes, cursorOffset } = taskShortcutReplacement({
      list,
      taskListType,
      taskItemType,
      paragraphType,
      index: 1,
      checked: true,
    });

    expect(nodes.map((node) => node.type.name)).toEqual(["bulletList", "taskList", "bulletList"]);
    expect(nodes[0]!.textContent).toBe("before");
    expect(nodes[1]!.child(0).attrs.checked).toBe(true);
    expect(nodes[2]!.textContent).toBe("after");
    expect(cursorOffset).toBe(nodes[0]!.nodeSize + 3);
  });

  it("handles a to-do as the first item", () => {
    const { nodes, cursorOffset } = taskShortcutReplacement({
      list: bulletList("to do", "after"),
      taskListType,
      taskItemType,
      paragraphType,
      index: 0,
      checked: false,
    });

    expect(nodes.map((node) => node.type.name)).toEqual(["taskList", "bulletList"]);
    expect(cursorOffset).toBe(3);
  });

  it("handles a to-do as the last item", () => {
    const { nodes } = taskShortcutReplacement({
      list: bulletList("before", "to do"),
      taskListType,
      taskItemType,
      paragraphType,
      index: 1,
      checked: false,
    });

    expect(nodes.map((node) => node.type.name)).toEqual(["bulletList", "taskList"]);
  });
});
