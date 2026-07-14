import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@geo/connectors": fileURLToPath(
        new URL("../../packages/connectors/src/index.ts", import.meta.url),
      ),
      "@geo/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@geo/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
      "@geo/db": fileURLToPath(new URL("../../packages/db/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
