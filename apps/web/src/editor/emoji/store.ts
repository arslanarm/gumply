/** The editor registers how `/emoji` opens the full picker at the caret. */
let opener: () => void = () => {};

export function setEmojiPickerOpener(next: () => void): void {
  opener = next;
}

export function requestEmojiPicker(): void {
  opener();
}
