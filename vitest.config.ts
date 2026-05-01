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
        // Bootstrap/composition and large operational tool orchestration modules
        // are validated through integration flows; keeping them in the unit
        // denominator masks actionable coverage deltas in feature modules.
        "src/server.ts",
        "src/api/admin.ts",
        "src/api/director.ts",
        "src/queue/queue-master.ts",
        "src/mcp/tools/pinterest-seo-tools.ts",
        "desktop/src/**/*.test.ts",
        "desktop/src/**/*.d.ts",
      ],
      reporter: ["text", "json-summary"],
    },
  },
});
