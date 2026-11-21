/**
 * The export font (spec/v0-6 §D, decided in task #yewapn9k): Inter, a
 * variable font under the SIL Open Font License (fonts/OFL.txt), in its
 * latin and latin-ext subsets, upright and italic. Boards on screen keep the
 * system font; the export stage lays text out in Inter, and the SVG embeds
 * the subsets its text actually uses, so the file looks the same everywhere.
 */
import latinItalicUrl from "./fonts/inter-latin-wght-italic.woff2?url";
import latinUrl from "./fonts/inter-latin-wght-normal.woff2?url";
import latinExtItalicUrl from "./fonts/inter-latin-ext-wght-italic.woff2?url";
import latinExtUrl from "./fonts/inter-latin-ext-wght-normal.woff2?url";

export const EXPORT_FONT_FAMILY = "Inter";
/** What the stage sets for sans text; anything Inter lacks falls back to the system. */
export const EXPORT_FONT_STACK = `"${EXPORT_FONT_FAMILY}", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;

// From @fontsource-variable/inter 5.3.0 (the subsets' unicode ranges).
const LATIN_RANGE =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT_RANGE =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

interface Face {
  url: string;
  style: "normal" | "italic";
  range: string;
  ext: boolean;
}

const FACES: readonly Face[] = [
  { url: latinUrl, style: "normal", range: LATIN_RANGE, ext: false },
  { url: latinItalicUrl, style: "italic", range: LATIN_RANGE, ext: false },
  { url: latinExtUrl, style: "normal", range: LATIN_EXT_RANGE, ext: true },
  { url: latinExtItalicUrl, style: "italic", range: LATIN_EXT_RANGE, ext: true },
];

const bytes = new Map<string, Promise<ArrayBuffer>>();

function fontBytes(url: string): Promise<ArrayBuffer> {
  let pending = bytes.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Couldn't load the export font (${response.status})`);
      return response.arrayBuffer();
    });
    pending.catch(() => bytes.delete(url));
    bytes.set(url, pending);
  }
  return pending;
}

let registered: Promise<void> | null = null;

/** Make Inter available to the page, so the export stage lays text out in it. */
export function loadExportFonts(): Promise<void> {
  registered ??= Promise.all(
    FACES.map(async (face) => {
      const font = new FontFace(EXPORT_FONT_FAMILY, await fontBytes(face.url), {
        style: face.style,
        weight: "100 900",
        unicodeRange: face.range,
      });
      await font.load();
      document.fonts.add(font);
    }),
  ).then(() => undefined);
  registered.catch(() => {
    registered = null;
  });
  return registered;
}

function base64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Whether `text` uses characters only the latin-ext subset has. */
export function needsLatinExt(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x100 && code <= 0x2ff && ![0x131, 0x152, 0x153, 0x2bb, 0x2bc, 0x2c6, 0x2da, 0x2dc].includes(code)) ||
      (code >= 0x1d00 && code <= 0x1eff) ||
      (code >= 0x2c60 && code <= 0x2c7f) ||
      (code >= 0xa720 && code <= 0xa7ff)
    ) {
      return true;
    }
  }
  return false;
}

/** `@font-face` rules (data URIs) for the subsets `text` needs. */
export async function embeddedFontCss(used: { text: string; italic: boolean }): Promise<string> {
  if (!used.text.trim()) return "";
  const ext = needsLatinExt(used.text);
  const faces = FACES.filter((face) => (!face.ext || ext) && (face.style === "normal" || used.italic));
  const rules = await Promise.all(
    faces.map(
      async (face) =>
        `@font-face{font-family:"${EXPORT_FONT_FAMILY}";font-style:${face.style};font-weight:100 900;unicode-range:${face.range};src:url(data:font/woff2;base64,${base64(await fontBytes(face.url))}) format("woff2");}`,
    ),
  );
  return rules.join("");
}
