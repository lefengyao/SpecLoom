import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
