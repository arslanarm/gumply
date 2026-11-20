import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { markdownItAlias } from "./markdown-it-path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // Consume core sources directly so UI edits don't need a core rebuild.
      {
        find: "@gumply/core",
        replacement: fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      },
      // One markdown-it in the bundle (#evh35bn7).
      markdownItAlias,
    ],
  },
  build: {
    rollupOptions: {
      output: {
        // The code GraphView and LocalGraphPanel share (react-force-graph, d3)
        // is named after its first module; give it a readable name instead.
        // Naming only: which module lands in which chunk is unchanged.
        chunkFileNames: (chunk) =>
          chunk.moduleIds.some((id) => id.includes("/src/graph/GraphCanvas"))
            ? "assets/graph-[hash].js"
            : "assets/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${process.env.GUMPLY_PORT ?? 8787}`,
    },
  },
});
