/**
 * v0.8 F2: the only module that imports Mermaid. `lib/diagram.ts` loads it
 * with a dynamic `import()`, so Mermaid (and d3) stay out of the main bundle.
 */
import mermaid from "mermaid";
import { mermaidConfig, type DiagramTheme } from "./diagram-config.js";

let counter = 0;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Render one diagram to an SVG string. Mermaid keeps global state (its
 * config), so renders run one at a time, each with the theme it asked for.
 */
export function renderMermaidSvg(source: string, theme: DiagramTheme): Promise<{ svg: string } | { error: string }> {
  const task = queue.then(async () => {
    counter += 1;
    const id = `gumply-mermaid-${counter}`;
    mermaid.initialize(mermaidConfig(theme));
    try {
      const { svg } = await mermaid.render(id, source);
      return { svg };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      // Mermaid leaves its scratch element (and an error SVG) in <body> on failure.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = task.catch(() => undefined);
  return task;
}
