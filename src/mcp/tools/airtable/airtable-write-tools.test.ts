/**
 * Tests for Airtable write MCP tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAirtableWriteTools } from "./airtable-write-tools.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

function mockVault(
  apiKey: string | undefined = "pat_test",
): SecretVaultService {
  return {
    isUnlocked: () => true,
    getByLabel: (label: string) =>
      label === "airtable-api-key" ? apiKey : undefined,
  } as unknown as SecretVaultService;
}

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as unknown as Response;
}

describe("Airtable Write Tools", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates 3 write tools", () => {
    const tools = createAirtableWriteTools(mockVault());
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "airtable-create-records",
      "airtable-update-records",
      "airtable-delete-records",
    ]);
  });

  it("all tools have category=data and riskLevel=medium", () => {
    const tools = createAirtableWriteTools(mockVault());
    for (const tool of tools) {
      expect(tool.category).toBe("data");
      expect(tool.riskLevel).toBe("medium");
    }
  });

  describe("airtable-create-records", () => {
    it("creates records and returns IDs", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          records: [
            {
              id: "recNEW1",
              createdTime: "2026-01-01T00:00:00Z",
              fields: { Name: "Alice" },
            },
            {
              id: "recNEW2",
              createdTime: "2026-01-01T00:00:00Z",
              fields: { Name: "Bob" },
            },
          ],
        }),
      );
      const tools = createAirtableWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-create-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Contacts",
        records: [{ fields: { Name: "Alice" } }, { fields: { Name: "Bob" } }],
      });
      expect(result.text).toContain("Created 2 record(s)");
      expect(result.text).toContain("recNEW1");
      expect(result.text).toContain("recNEW2");
    });

    it("returns error for > 10 records", async () => {
      const tools = createAirtableWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-create-records")!;
      const records = Array.from({ length: 11 }, () => ({
        fields: { Name: "X" },
      }));
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "T",
        records,
      });
      expect(result.isError).toBe(true);
    });

    it("returns error when vault has no key", async () => {
      const tools = createAirtableWriteTools(mockVault(undefined));
      const tool = tools.find((t) => t.name === "airtable-create-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "T",
        records: [{ fields: { A: 1 } }],
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("airtable-update-records", () => {
    it("updates records and returns IDs", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          records: [
            {
              id: "recABC",
              createdTime: "2026-01-01T00:00:00Z",
              fields: { Name: "Updated" },
            },
          ],
        }),
      );
      const tools = createAirtableWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-update-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Contacts",
        records: [{ id: "recABC", fields: { Name: "Updated" } }],
      });
      expect(result.text).toContain("Updated 1 record(s)");
      expect(result.text).toContain("recABC");
    });
  });

  describe("airtable-delete-records", () => {
    it("deletes records", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          records: [
            { id: "recABC", deleted: true },
            { id: "recDEF", deleted: true },
          ],
        }),
      );
      const tools = createAirtableWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-delete-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Contacts",
        recordIds: ["recABC", "recDEF"],
      });
      expect(result.text).toContain("Deleted 2 record(s)");
    });

    it("returns error for > 10 record IDs", async () => {
      const tools = createAirtableWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-delete-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "T",
        recordIds: Array.from({ length: 11 }, (_, i) => `rec${i}`),
      });
      expect(result.isError).toBe(true);
    });
  });
});
