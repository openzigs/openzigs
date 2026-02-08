import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDatabaseTools } from "./database-tools.js";

describe("Database Tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should create three tools", () => {
    const tools = createDatabaseTools({ sidecarUrl: "http://localhost:5303" });
    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t.name);
    expect(names).toContain("db-list-tables");
    expect(names).toContain("db-describe");
    expect(names).toContain("db-query");
  });

  it("should assign correct risk levels", () => {
    const tools = createDatabaseTools({ sidecarUrl: "http://localhost:5303" });
    const riskMap = Object.fromEntries(tools.map((t) => [t.name, t.riskLevel]));

    expect(riskMap["db-list-tables"]).toBe("low");
    expect(riskMap["db-describe"]).toBe("low");
    expect(riskMap["db-query"]).toBe("high");
  });

  it("should categorize all tools as data", () => {
    const tools = createDatabaseTools({ sidecarUrl: "http://localhost:5303" });
    for (const tool of tools) {
      expect(tool.category).toBe("data");
    }
  });

  it("db-query should call sidecar with SQL statement", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { columns: ["id", "name"], rows: [["1", "Alice"]], rowCount: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createDatabaseTools({ sidecarUrl: "http://localhost:5303" });
    const queryTool = tools.find((t) => t.name === "db-query")!;
    const result = await queryTool.handler({ query: "SELECT * FROM users LIMIT 10" });

    expect(result.isError).toBeUndefined();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("db_query");
    expect(body.params.query).toBe("SELECT * FROM users LIMIT 10");
  });

  it("db-describe should include table name", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          result: { columns: [{ name: "id", type: "INTEGER" }] },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tools = createDatabaseTools({ sidecarUrl: "http://localhost:5303" });
    const describeTool = tools.find((t) => t.name === "db-describe")!;
    await describeTool.handler({ table: "users" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.method).toBe("db_describe");
    expect(body.params.table).toBe("users");
  });

  it("should handle sidecar errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Connection refused")));

    const tools = createDatabaseTools({ sidecarUrl: "http://localhost:5303" });
    const queryTool = tools.find((t) => t.name === "db-query")!;
    const result = await queryTool.handler({ query: "SELECT 1" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("Failed to reach Database sidecar");
  });
});
