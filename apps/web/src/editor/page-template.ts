/**
 * `/template` → "Insert page template…" (v0.7 C, #5hrsrqsj). The slash item
 * asks the app (which owns the picker and the page) to pick a template; an
 * empty page is filled on the server (body + properties), otherwise the
 * template's body goes in at the caret.
 */
export interface PageTemplateRequest {
  /** The page has no text yet (only then are properties copied too). */
  empty: boolean;
  /** Insert Markdown where the slash command was typed. */
  insert: (markdown: string) => void;
}

let handler: (request: PageTemplateRequest) => void = () => {};

export function setPageTemplateHandler(next: (request: PageTemplateRequest) => void): void {
  handler = next;
}

export function requestPageTemplate(request: PageTemplateRequest): void {
  handler(request);
}
