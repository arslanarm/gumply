import { describe, expect, it } from "vitest";
import { fileUrl } from "../src/api/client.js";
import {
  fileExtension,
  fileNameWithoutExtension,
  formatFileSize,
  isImageMime,
} from "../src/lib/files.js";

describe("formatFileSize", () => {
  it("formats bytes, KB and MB", () => {
    expect(formatFileSize(74)).toBe("74 B");
    expect(formatFileSize(416)).toBe("416 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(640 * 1024)).toBe("640 KB");
    expect(formatFileSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
  });

  it("returns nothing for unknown sizes", () => {
    expect(formatFileSize(0)).toBe("");
    expect(formatFileSize(Number.NaN)).toBe("");
  });
});

describe("file name helpers", () => {
  it("strips the extension for image captions", () => {
    expect(fileNameWithoutExtension("q1-demo.svg")).toBe("q1-demo");
    expect(fileNameWithoutExtension("notes")).toBe("notes");
  });

  it("shows an uppercase extension badge", () => {
    expect(fileExtension("brief.pdf")).toBe("PDF");
    expect(fileExtension("notes")).toBe("FILE");
  });

  it("detects image MIME types", () => {
    expect(isImageMime("image/svg+xml")).toBe(true);
    expect(isImageMime("text/plain; charset=utf-8")).toBe(false);
  });
});

describe("fileUrl", () => {
  it("maps vault paths through the API", () => {
    expect(fileUrl("attachments/photo.png")).toBe("/api/files/attachments/photo.png");
    expect(fileUrl("attachments/with space.txt")).toBe("/api/files/attachments/with%20space.txt");
  });

  it("keeps absolute and external URLs", () => {
    expect(fileUrl("/api/files/x.png")).toBe("/api/files/x.png");
    expect(fileUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(fileUrl("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
  });
});
