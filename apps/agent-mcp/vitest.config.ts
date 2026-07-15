import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@geo/agent/pi": fileURLToPath(
        new URL("../../packages/agent/src/pi-runtime.ts", import.meta.url),
      ),
      "@geo/agent/plastic-promise-transport": fileURLToPath(
        new URL("../../packages/agent/src/plastic-promise-transport.ts", import.meta.url),
      ),
      "@geo/agent": fileURLToPath(new URL("../../packages/agent/src/index.ts", import.meta.url)),
      "@geo/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url),
      ),
      "@geo/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
