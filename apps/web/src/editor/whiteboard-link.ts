/**
 * `/whiteboard` (spec/whiteboard §4): the slash item asks the open editor to
 * create a board inside the current page and link to it. The editor registers
 * how (it needs the app's create call and its own caret).
 */
let creator: () => void = () => {};

export function setWhiteboardCreator(next: () => void): void {
  creator = next;
}

export function requestWhiteboard(): void {
  creator();
}
