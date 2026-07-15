import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@geo/authz": resolve(import.meta.dirname, "../../packages/authz/src/index.ts"),
      "@geo/connectors": resolve(import.meta.dirname, "../../packages/connectors/src/index.ts"),
      "@geo/contracts": resolve(import.meta.dirname, "../../packages/contracts/src/index.ts"),
      "@geo/core": resolve(import.meta.dirname, "../../packages/core/src/index.ts"),
      "@geo/research": resolve(import.meta.dirname, "../../packages/research/src/index.ts"),
      "@geo/visibility": resolve(import.meta.dirname, "../../packages/visibility/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
