/**
 * `/database` (D34): the slash item asks the open editor to create a database
 * view inside the page and embed it; the editor registers how (it owns the
 * caret and the app's callbacks), as for `/whiteboard`.
 */
let creator: () => void = () => {};

export function setDatabaseCreator(next: () => void): void {
  creator = next;
}

export function requestDatabase(): void {
  creator();
}
