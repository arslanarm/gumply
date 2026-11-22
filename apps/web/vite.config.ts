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
      // F2: Mermaid's optional ELK layout pulls in elkjs (EPL-2.0 / GPL-3.0),
      // which Gumply doesn't ship: a stub that refuses takes its place.
      {
        find: /^elkjs\/lib\/elk\.bundled\.js$/,
        replacement: fileURLToPath(new URL("./src/lib/elk-stub.ts", import.meta.url)),
      },
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
      // The API listens on loopback only (#rv57cvhm). Keep the browser's Host
      // (changeOrigin: false; the string shorthand would rewrite it): the
      // API accepts writes whose Origin matches that Host (#kmff9wkt), so the
      // app works on any Vite port and in `vite preview` without settings.
      "/api": {
        target: `http://127.0.0.1:${process.env.GUMPLY_PORT ?? 8787}`,
        changeOrigin: false,
      },
    },
  },
});
