/** The editor registers how to open the image/file picker for slash items. */
export type AttachmentPickerKind = "image" | "file";

let picker: (kind: AttachmentPickerKind) => void = () => {};

export function setAttachmentPicker(next: (kind: AttachmentPickerKind) => void): void {
  picker = next;
}

export function requestAttachmentPicker(kind: AttachmentPickerKind): void {
  picker(kind);
}
