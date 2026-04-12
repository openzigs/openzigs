import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "desktop/src/**/*.test.ts"],
    coverage: {
      include: ["src/**/*.ts", "desktop/src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "desktop/src/**/*.test.ts",
        "desktop/src/**/*.d.ts",
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
