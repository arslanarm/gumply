import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Consume core sources directly so UI edits don't need a core rebuild.
      "@gumply/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The API listens on loopback only (#rv57cvhm). Host and Origin are
      // passed through (localhost:<web port>), which its guard accepts.
      "/api": `http://127.0.0.1:${process.env.GUMPLY_PORT ?? 8787}`,
    },
  },
});
