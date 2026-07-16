import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@geo/contracts": resolve(import.meta.dirname, "../../packages/contracts/src/index.ts"),
    },
  },
  server: {
    port: 4173,
    strictPort: false,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4100",
        changeOrigin: false,
      },
      "/health": {
        target: "http://127.0.0.1:4100",
        changeOrigin: false,
      },
    },
  },
  preview: {
    port: 4173,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
