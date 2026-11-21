import type { NodeViewRendererProps } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { t } from "../i18n/index.js";

/**
 * TipTap's TaskItem node view builds the checkbox aria-label from the node it
 * captured when the view was created. A to-do created empty from the slash
 * menu therefore keeps "Mark to-do as done" after typing, and a freshly
 * rendered checked item can be labelled with the wrong action (#zptww5hd).
 *
 * This is the same node view with two fixes: keep the latest node in a local,
 * and set `checkbox.checked` before computing its label.
 */
export const AccessibleTaskItem = TaskItem.extend({
  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor }: NodeViewRendererProps) => {
      let currentNode = node;
      const listItem = document.createElement("li");
      const checkboxWrapper = document.createElement("label");
      const checkboxStyler = document.createElement("span");
      const checkbox = document.createElement("input");
      const content = document.createElement("div");

      const updateA11Y = () => {
        checkbox.ariaLabel =
          this.options.a11y?.checkboxLabel?.(currentNode, checkbox.checked) ||
          t("tasks.checkboxFallback", { text: currentNode.textContent || t("tasks.emptyItem") });
      };

      checkboxWrapper.contentEditable = "false";
      checkbox.type = "checkbox";
      checkbox.checked = node.attrs.checked;
      updateA11Y();

      checkbox.addEventListener("mousedown", (event) => event.preventDefault());
      checkbox.addEventListener("change", (event) => {
        const target = event.target as HTMLInputElement;
        if (!editor.isEditable && !this.options.onReadOnlyChecked) {
          checkbox.checked = !checkbox.checked;
          return;
        }

        const { checked } = target;
        if (editor.isEditable && typeof getPos === "function") {
          editor
            .chain()
            .focus(undefined, { scrollIntoView: false })
            .command(({ tr }) => {
              const position = getPos();
              if (typeof position !== "number") return false;
              const nodeAtPosition = tr.doc.nodeAt(position);
              if (!nodeAtPosition) return false;
              tr.setNodeMarkup(position, undefined, { ...nodeAtPosition.attrs, checked });
              return true;
            })
            .run();
        }

        if (!editor.isEditable && this.options.onReadOnlyChecked) {
          if (!this.options.onReadOnlyChecked(currentNode as ProseMirrorNode, checked)) {
            checkbox.checked = !checkbox.checked;
          }
        }
      });

      Object.entries(this.options.HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });
      listItem.dataset.checked = String(node.attrs.checked);

      checkboxWrapper.append(checkbox, checkboxStyler);
      listItem.append(checkboxWrapper, content);
      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode: ProseMirrorNode) => {
          if (updatedNode.type !== this.type) return false;
          currentNode = updatedNode;
          listItem.dataset.checked = String(updatedNode.attrs.checked);
          checkbox.checked = updatedNode.attrs.checked;
          updateA11Y();
          return true;
        },
        ignoreMutation: (mutation) =>
          mutation.type === "attributes" && mutation.target === checkbox,
      };
    };
  },
});
