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

/** Read-only, fitted view of a board for `![[Board.canvas]]` in pages (D30). */
export const LazyBoardPreview = lazy(() => import("./BoardPreview.js"));
export type { BoardPreviewProps } from "./BoardPreview.js";
