import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src-v2/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 60,
        branches: 60,
        functions: 60,
        statements: 60,
      },
    },
  },
});