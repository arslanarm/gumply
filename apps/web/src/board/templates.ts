/**
 * Built-in board templates (spec/v0-6 §D). A template is plain data: `build()`
 * returns a fresh board (new ids every time) made only of the standard JSON
 * Canvas node types plus Gumply's usual `gumply` extras, so a board made from
 * one is a normal `.canvas` file that Obsidian opens as is.
 *
 * Nodes come in drawing order: frames first (behind), then their content.
 */
import type { CanvasBoard, CanvasEdge, CanvasNode, CanvasSide, GumplyShape } from "@gumply/core";
import { createEdge, createFrame, createShape, createSticky, createText, type Rect } from "./model.js";

export type BoardTemplateId = "kanban" | "mind-map" | "retrospective" | "flowchart" | "weekly-plan";

export interface BoardTemplate {
  id: BoardTemplateId;
  name: string;
  /** One short line for the gallery. */
  description: string;
  build: () => CanvasBoard;
}

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

function edge(
  from: CanvasNode,
  fromSide: CanvasSide,
  to: CanvasNode,
  toSide: CanvasSide,
  label?: string,
): CanvasEdge {
  const created = createEdge(from.id, fromSide, to.id, toSide);
  return label ? { ...created, label } : created;
}

/** A mind-map branch: a plain line, no arrowhead. */
function branchEdge(from: CanvasNode, fromSide: CanvasSide, to: CanvasNode, toSide: CanvasSide): CanvasEdge {
  return { ...createEdge(from.id, fromSide, to.id, toSide), toEnd: "none" };
}

const shape = (kind: GumplyShape, area: Rect, text: string, color?: string): CanvasNode =>
  createShape(area, kind, color, text);

/* ------------------------------------------------------------------------ */

function kanban(): CanvasBoard {
  const columns = [
    { label: "To do", color: undefined },
    { label: "Doing", color: "5" },
    { label: "Done", color: "4" },
  ] as const;
  const width = 300;
  const gap = 40;
  const frames = columns.map((column, index) => createFrame(rect(index * (width + gap), 0, width, 640), column.label, column.color));
  const card = (column: number, row: number, text: string, color: string): CanvasNode =>
    createSticky(rect(column * (width + gap) + 24, 24 + row * 124, width - 48, 104), color, text);
  return {
    nodes: [
      ...frames,
      card(0, 0, "Drag cards between columns", "3"),
      card(0, 1, "Double-click a card to edit it", "3"),
      card(0, 2, "Add a card with the sticky tool (S)", "3"),
      card(1, 0, "Work in progress", "5"),
      card(2, 0, "Finished work", "4"),
    ],
    edges: [],
  };
}

function mindMap(): CanvasBoard {
  // Ellipses pad by a share of their width, so they stay tall enough for text.
  const center = shape("ellipse", rect(-120, -80, 240, 160), "**Main idea**", "6");
  const branches = [
    { text: "Idea", area: rect(-500, -230, 200, 90), from: "left", to: "right", color: "5" },
    { text: "Idea", area: rect(300, -230, 200, 90), from: "right", to: "left", color: "4" },
    { text: "Idea", area: rect(-500, 140, 200, 90), from: "left", to: "right", color: "2" },
    { text: "Idea", area: rect(300, 140, 200, 90), from: "right", to: "left", color: "1" },
  ] as const;
  const nodes: CanvasNode[] = [center];
  const edges: CanvasEdge[] = [];
  for (const branch of branches) {
    const node = shape("rounded", branch.area, branch.text, branch.color);
    nodes.push(node);
    edges.push(branchEdge(center, branch.from, node, branch.to));
  }
  // One branch already grown a level, to show the pattern.
  const first = nodes[1]!;
  for (const [index, text] of ["Detail", "Detail"].entries()) {
    const leaf = shape("rounded", rect(-740, -290 + index * 100, 160, 70), text);
    nodes.push(leaf);
    edges.push(branchEdge(first, "left", leaf, "right"));
  }
  return { nodes, edges };
}

function retrospective(): CanvasBoard {
  const columns = [
    { label: "Went well", color: "4", prompt: "What should we keep doing?" },
    { label: "To improve", color: "2", prompt: "What slowed us down?" },
    { label: "Action items", color: "5", prompt: "Who does what, by when?" },
  ] as const;
  const width = 360;
  const gap = 40;
  const nodes: CanvasNode[] = [];
  const title = createText(rect(0, -110, 700, 60), "# Retrospective");
  for (const [index, column] of columns.entries()) {
    nodes.push(createFrame(rect(index * (width + gap), 0, width, 560), column.label, column.color));
  }
  nodes.push(title);
  for (const [index, column] of columns.entries()) {
    nodes.push(createSticky(rect(index * (width + gap) + 30, 30, 140, 140), column.color, column.prompt));
  }
  return { nodes, edges: [] };
}

function flowchart(): CanvasBoard {
  const start = shape("ellipse", rect(10, 0, 180, 110), "Start", "4");
  const step = shape("rounded", rect(0, 180, 200, 90), "Do something");
  const decision = shape("diamond", rect(-20, 340, 240, 160), "Is it done?", "3");
  const fix = shape("rounded", rect(330, 375, 200, 90), "Fix it");
  const end = shape("ellipse", rect(10, 580, 180, 110), "End", "1");
  return {
    nodes: [start, step, decision, fix, end],
    edges: [
      edge(start, "bottom", step, "top"),
      edge(step, "bottom", decision, "top"),
      edge(decision, "right", fix, "left", "No"),
      edge(fix, "top", step, "right"),
      edge(decision, "bottom", end, "top", "Yes"),
    ],
  };
}

function weeklyPlan(): CanvasBoard {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Weekend"];
  const width = 240;
  const gap = 24;
  const nodes: CanvasNode[] = [createFrame(rect(0, 0, days.length * (width + gap) - gap, 220), "Goals this week", "6")];
  for (const [index, day] of days.entries()) {
    nodes.push(createFrame(rect(index * (width + gap), 280, width, 520), day, index === days.length - 1 ? "5" : undefined));
  }
  nodes.push(createSticky(rect(24, 30, 200, 160), "6", "One thing that would make this week great"));
  nodes.push(createSticky(rect(24 + 224, 30, 200, 160), "6", "Another goal"));
  nodes.push(createSticky(rect(20, 300, width - 40, 90), "3", "A task for Monday"));
  return { nodes, edges: [] };
}

export const BOARD_TEMPLATES: readonly BoardTemplate[] = [
  { id: "kanban", name: "Kanban", description: "To do, Doing and Done columns", build: kanban },
  { id: "mind-map", name: "Mind map", description: "A central idea with branches", build: mindMap },
  { id: "retrospective", name: "Retrospective", description: "Went well, To improve, Action items", build: retrospective },
  { id: "flowchart", name: "Flowchart", description: "Start, steps, a decision and an end", build: flowchart },
  { id: "weekly-plan", name: "Weekly plan", description: "Goals and a column per day", build: weeklyPlan },
];

export function boardTemplate(id: string): BoardTemplate | undefined {
  return BOARD_TEMPLATES.find((template) => template.id === id);
}
