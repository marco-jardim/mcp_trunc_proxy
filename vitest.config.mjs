import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.mjs"],
    testTimeout: 30000,
    hookTimeout: 10000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true
      }
    }
  }
});
