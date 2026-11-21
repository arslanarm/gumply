import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { markdownItAlias } from "./apps/web/markdown-it-path";

export default defineConfig({
  resolve: {
    alias: [
      // Tests run against core sources so `npm test` works without a build.
      {
        find: "@gumply/core",
        replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      },
      // The markdown-it the editor ships (see apps/web/markdown-it-path.ts).
      markdownItAlias,
    ],
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "e2e/support/*.test.ts"],
    reporters: "default",
  },
});
