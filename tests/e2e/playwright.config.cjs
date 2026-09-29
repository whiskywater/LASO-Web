const { defineConfig } = require("@playwright/test");
const path = require("node:path");

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: "*.spec.cjs",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: path.resolve(__dirname, "../../playwright-report"), open: "never" }]],
  outputDir: path.resolve(__dirname, "../../test-results"),
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
  },
});
