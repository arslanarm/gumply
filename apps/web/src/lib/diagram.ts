/**
 * v0.8 F2: Mermaid diagrams. The render API for the editor's code blocks,
 * page previews, board stickies and (later) G1's HTML export.
 *
 * - Mermaid and d3 live in their own chunk (`mermaid-chunk.ts`), loaded on
 *   the first diagram on screen.
 * - Strict security (`diagram-config.ts`), and then our own pass over the
 *   SVG: no `<script>`, no `<foreignObject>`, no `on*` attributes, no links
 *   or images that leave the document. Nothing in a vault diagram can run
 *   or load anything from the network.
 * - Errors never throw: the caller shows them inline.
 * - Diagrams follow the app theme and re-render when it changes.
 */
import { t } from "../i18n/index.js";
import type { DiagramTheme } from "./diagram-config.js";

export type DiagramResult = { svg: string } | { error: string };

type Chunk = typeof import("./mermaid-chunk.js");
let chunk: Promise<Chunk> | null = null;
const loadMermaid = (): Promise<Chunk> => (chunk ??= import("./mermaid-chunk.js"));

export function currentDiagramTheme(): DiagramTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

const SAFE_HREF = /^#[\w:.-]*$/;

/** Remove anything that could run or reach the network from a rendered SVG. */
export function sanitizeDiagramSvg(svg: string): string {
  // Parsed as HTML (lenient, as the browser would insert it), never executed:
  // a document from DOMParser runs no scripts and loads nothing.
  const doc = new DOMParser().parseFromString(svg, "text/html");
  const root = doc.body.querySelector("svg");
  if (!root) return "";
  for (const element of [...root.querySelectorAll("script, foreignObject, iframe, object, embed, img")]) element.remove();
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      else if ((name === "href" || name === "xlink:href" || name === "src") && !SAFE_HREF.test(attribute.value.trim())) {
        element.removeAttribute(attribute.name);
      } else if (name === "style" && /url\(\s*['"]?(?!#)/i.test(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
    // A link that no longer points anywhere is plain text.
    if (element.localName === "a") element.replaceWith(...element.childNodes);
  }
  // @import or url() in the diagram's own <style> could fetch.
  for (const style of [...root.querySelectorAll("style")]) {
    style.textContent = (style.textContent ?? "").replace(/@import[^;]*;?/gi, "").replace(/url\(\s*['"]?(?!#)[^)]*\)/gi, "none");
  }
  return root.outerHTML;
}

/** Render a diagram; never throws. */
export async function renderMermaid(source: string, options: { theme?: DiagramTheme } = {}): Promise<DiagramResult> {
  if (!source.trim()) return { error: t("diagram.empty") };
  try {
    const mermaid = await loadMermaid();
    const result = await mermaid.renderMermaidSvg(source, options.theme ?? currentDiagramTheme());
    if ("error" in result) return result;
    const svg = sanitizeDiagramSvg(result.svg);
    return svg ? { svg } : { error: t("diagram.failed") };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Show a result in `element`: the SVG, or the error (source shown, message underneath). */
function show(element: HTMLElement, source: string, result: DiagramResult): void {
  element.classList.toggle("has-diagram-error", "error" in result);
  if ("svg" in result) {
    element.innerHTML = result.svg;
    return;
  }
  const box = document.createElement("div");
  box.className = "diagram-error";
  const title = document.createElement("div");
  title.className = "diagram-error-title";
  title.textContent = t("diagram.error");
  const message = document.createElement("div");
  message.className = "diagram-error-message";
  message.textContent = result.error;
  box.append(title, message);
  if (element.dataset.diagramShowSource === "true") {
    const pre = document.createElement("pre");
    pre.textContent = source;
    box.append(pre);
  }
  element.replaceChildren(box);
}

const mounted = new Map<HTMLElement, string>();
let themeObserver: MutationObserver | null = null;

function watchTheme(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  themeObserver = new MutationObserver(() => {
    for (const [element, source] of mounted) {
      if (!element.isConnected) mounted.delete(element);
      else void renderInto(element, source);
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

async function renderInto(element: HTMLElement, source: string): Promise<void> {
  const token = String(Number(element.dataset.diagramToken ?? "0") + 1);
  element.dataset.diagramToken = token;
  const theme = currentDiagramTheme();
  const result = await renderMermaid(source, { theme });
  if (element.dataset.diagramToken !== token) return;
  element.dataset.diagramTheme = theme;
  show(element, source, result);
}

/**
 * Render `source` into `element` and keep it in step with the app theme.
 * Calling it again with new source replaces the diagram.
 */
export function mountDiagram(element: HTMLElement, source: string): Promise<void> {
  mounted.set(element, source);
  watchTheme();
  element.classList.add("diagram");
  return renderInto(element, source);
}

/** Render every `[data-mermaid]` placeholder under `root` (previews, stickies). */
export function hydrateDiagrams(root: ParentNode): Promise<void> {
  const nodes = [...root.querySelectorAll<HTMLElement>("[data-mermaid]")];
  return Promise.all(nodes.map((node) => mountDiagram(node, node.dataset.mermaid ?? ""))).then(() => undefined);
}
