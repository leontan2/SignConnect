import { defineConfig, devices } from "@playwright/test";

const e2eTestMatch = "e2e/**/*.spec.ts";
const performanceTestMatch = "performance/**/*.spec.ts";
const fakeCameraArgs = [
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream"
];

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  // These serial specs deliberately stop/restart owned services. Retrying a
  // partially completed mutation would make the external state ambiguous.
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.SIGNCONNECT_E2E_BASE_URL || "http://127.0.0.1:3000",
    permissions: ["camera"],
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      testMatch: e2eTestMatch,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: fakeCameraArgs }
      }
    },
    {
      name: "chrome",
      testMatch: e2eTestMatch,
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        launchOptions: { args: fakeCameraArgs }
      }
    },
    {
      name: "edge",
      testMatch: e2eTestMatch,
      use: {
        ...devices["Desktop Edge"],
        channel: "msedge",
        launchOptions: { args: fakeCameraArgs }
      }
    },
    {
      name: "performance",
      testMatch: performanceTestMatch,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: fakeCameraArgs }
      }
    }
  ]
});
