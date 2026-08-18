import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Fare adapters hit the network; give live-fetch tests room to breathe.
    testTimeout: 30_000,
  },
});
