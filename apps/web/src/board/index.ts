/**
 * Whiteboard entry point. The editor itself (React Flow, perfect-freehand)
 * is code-split: import `LazyBoardEditor` so a page load never pays for it.
 */
import { lazy } from "react";

export type { BoardEditorControls, BoardEditorProps, BoardPageOption, BoardTool } from "./BoardEditor.js";
export type { BoardCardRenderProps, BoardRenderers, BoardTextRenderProps } from "./context.js";
export type { BoardViewControls, BoardViewProps } from "./BoardView.js";

export { BOARD_DRAG_MIME } from "./constants.js";

export const LazyBoardEditor = lazy(() => import("./BoardEditor.js"));
