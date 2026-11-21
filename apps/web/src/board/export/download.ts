/**
 * Turning an exported SVG into a file (spec/v0-6 §D): PNGs are rasterised
 * from the SVG at 2×, and files are saved with a normal browser download.
 * In the desktop app the same download opens the native Save dialog (the
 * window has no preload API by design, D26).
 */

/**
 * Under the canvas limits browsers enforce (Chrome: 32767 px a side, ~268 M
 * px), and small enough to encode quickly: 64 M px is 8000×8000.
 */
const MAX_SIDE = 16_384;
const MAX_AREA = 64_000_000;

/** The scale for a PNG: 2× unless that would exceed the canvas limits. */
export function pngScale(width: number, height: number, wanted = 2): number {
  const bySide = MAX_SIDE / Math.max(width, height, 1);
  const byArea = Math.sqrt(MAX_AREA / Math.max(width * height, 1));
  return Math.max(0.05, Math.min(wanted, bySide, byArea));
}

export async function svgToPng(svg: string, width: number, height: number, scale: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Couldn't draw the image (no canvas)");
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't encode the PNG"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A file name from the board's title: no path separators or reserved characters. */
export function exportFileName(title: string, extension: "png" | "svg", selection: boolean): string {
  const base = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim() || "Whiteboard";
  return `${base}${selection ? " (selection)" : ""}.${extension}`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the download, or a Save dialog left open a while, to read it.
  window.setTimeout(() => URL.revokeObjectURL(url), 10 * 60_000);
}
