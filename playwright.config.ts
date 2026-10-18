import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  reporter: "list",
  outputDir: ".local/playwright-results",
  use: { trace: "retain-on-failure" },
});
