/**
 * `/whiteboard` (spec/whiteboard §4): the slash item asks the open editor to
 * create a board inside the current page and link to it. The editor registers
 * how (it needs the app's create call and its own caret).
 */
export interface WhiteboardRequest {
  /** `/template`: pick a template in the gallery first (spec/v0-6 §D). */
  pickTemplate?: boolean;
}

let creator: (request: WhiteboardRequest) => void = () => {};

export function setWhiteboardCreator(next: (request: WhiteboardRequest) => void): void {
  creator = next;
}

export function requestWhiteboard(request: WhiteboardRequest = {}): void {
  creator(request);
}
