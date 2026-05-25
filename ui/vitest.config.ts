import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.{ts,tsx}"],
    setupFiles: ["./test-setup.ts"],
    globals: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "json", "json-summary"],
      include: [
        "app/**/*.ts",
        "app/**/*.tsx",
        "components/**/*.ts",
        "components/**/*.tsx",
        "lib/**/*.ts",
        "lib/**/*.tsx",
        "hooks/**/*.ts",
        "hooks/**/*.tsx",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.d.ts",
        "**/*.stories.ts",
        "**/*.stories.tsx",
        ".next/**",
        "node_modules/**",
        "coverage/**",
        "playwright/**",
        "e2e/**",
        "**/test-setup.ts",
      ],
    },
  },
});
