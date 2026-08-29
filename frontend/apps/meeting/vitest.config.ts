import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  server: {
    fs: {
      allow: [repositoryRoot]
    }
  },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    fakeTimers: {
      now: 0,
      shouldClearNativeTimers: true
    }
  }
});
