/**
 * Only `createLowlight`: a named re-export lets the bundler drop lowlight's
 * `all`/`common` grammar sets (a dynamic `import("lowlight")` would keep them
 * all, ~300 kB gzip). Grammars are registered one by one on demand.
 */
export { createLowlight } from "lowlight";
