/**
 * v0.8 F2: the Mermaid configuration, kept pure (no mermaid import) so tests
 * can pin every security-relevant key.
 */

export type DiagramTheme = "light" | "dark";

/** The system font stack the app uses: diagrams never fetch a web font. */
export const DIAGRAM_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Keys a diagram's own `%%{init: …}%%` may never change. */
export const SECURE_KEYS = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "htmlLabels",
  "maxTextSize",
  "maxEdges",
  "fontFamily",
  "themeCSS",
  "themeVariables",
  "flowchart",
  "class",
  "dompurifyConfig",
] as const;

export function mermaidConfig(theme: DiagramTheme) {
  return {
    startOnLoad: false,
    // Strict: labels are text, `click` callbacks and script links are dropped.
    securityLevel: "strict" as const,
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    class: { htmlLabels: false },
    secure: [...SECURE_KEYS],
    // Bounds for huge or hostile diagrams.
    maxTextSize: 50_000,
    maxEdges: 2_000,
    fontFamily: DIAGRAM_FONT,
    theme: theme === "dark" ? ("dark" as const) : ("default" as const),
    deterministicIds: true,
  };
}
