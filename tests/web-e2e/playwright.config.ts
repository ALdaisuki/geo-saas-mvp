import { defineConfig } from "@playwright/test";

const configuredChannel = process.env.PLAYWRIGHT_CHANNEL;
const channel = configuredChannel ?? (process.platform === "win32" ? "msedge" : undefined);
const webPort = process.env.WEB_E2E_PORT ?? "4174";
if (!/^\d+$/.test(webPort)) {
  throw new TypeError("WEB_E2E_PORT must contain only digits");
}
const baseURL = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "./src",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL,
    colorScheme: "light",
    locale: "zh-CN",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off",
    launchOptions: channel === undefined ? {} : { channel },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { viewport: { width: 1440, height: 900 } },
    },
    {
      name: "mobile-chromium",
      use: { viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: `corepack pnpm --filter @geo/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
