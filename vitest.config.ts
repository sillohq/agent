import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    // Tests build throwaway HOME and project directories; never the real ones.
    env: { SILLO_AGENT_TEST: "1" },
  },
});
