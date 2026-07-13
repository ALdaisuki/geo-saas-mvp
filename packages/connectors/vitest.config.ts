import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@geo/contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
      "@geo/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
});
