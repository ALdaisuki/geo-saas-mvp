import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@geo/authz": fileURLToPath(new URL("../authz/src/index.ts", import.meta.url)),
      "@geo/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
      "@geo/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
