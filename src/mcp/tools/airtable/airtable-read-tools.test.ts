/**
 * Tests for Airtable read MCP tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAirtableReadTools } from "./airtable-read-tools.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

// ── Mock vault ───────────────────────────────────────────────────────────

function mockVault(
  apiKey: string | undefined = "pat_test",
): SecretVaultService {
  return {
    isUnlocked: () => true,
    getByLabel: (label: string) =>
      label === "airtable-api-key" ? apiKey : undefined,
  } as unknown as SecretVaultService;
}

// ── Mock fetch ───────────────────────────────────────────────────────────

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers(),
  } as unknown as Response;
}

describe("Airtable Read Tools", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates 5 read tools", () => {
    const tools = createAirtableReadTools(mockVault());
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("airtable-list-bases");
    expect(names).toContain("airtable-list-tables");
    expect(names).toContain("airtable-read-records");
    expect(names).toContain("airtable-list-views");
    expect(names).toContain("airtable-get-fields");
  });

  it("all tools have category=data and riskLevel=low", () => {
    const tools = createAirtableReadTools(mockVault());
    for (const tool of tools) {
      expect(tool.category).toBe("data");
      expect(tool.riskLevel).toBe("low");
    }
  });

  describe("airtable-list-bases", () => {
    it("returns markdown table of bases", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          bases: [
            { id: "appABC123456789", name: "CRM", permissionLevel: "edit" },
            {
              id: "appDEF123456789",
              name: "Projects",
              permissionLevel: "read",
            },
          ],
        }),
      );
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-list-bases")!;
      const result = await tool.handler({});
      expect(result.text).toContain("CRM");
      expect(result.text).toContain("Projects");
      expect(result.text).toContain("appABC123456789");
    });

    it("returns error when vault is locked", async () => {
      const vault = {
        isUnlocked: () => false,
      } as unknown as SecretVaultService;
      const tools = createAirtableReadTools(vault);
      const tool = tools.find((t) => t.name === "airtable-list-bases")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Secret Vault");
    });

    it("returns error when no API key in vault", async () => {
      const tools = createAirtableReadTools(mockVault(undefined));
      const tool = tools.find((t) => t.name === "airtable-list-bases")!;
      const result = await tool.handler({});
      expect(result.isError).toBe(true);
      // Should mention the missing key or surface an API error
      expect(result.text).toMatch(/airtable-api-key|Cannot read|undefined/i);
    });
  });

  describe("airtable-list-tables", () => {
    it("returns markdown table of tables", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          tables: [
            {
              id: "tblABC",
              name: "Contacts",
              primaryFieldId: "fld1",
              fields: [{ id: "fld1", name: "Name", type: "singleLineText" }],
              views: [{ id: "viw1", name: "Grid", type: "grid" }],
            },
          ],
        }),
      );
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-list-tables")!;
      const result = await tool.handler({ baseId: "appABC123456789" });
      expect(result.text).toContain("Contacts");
      expect(result.text).toContain("tblABC");
    });
  });

  describe("airtable-read-records", () => {
    it("returns records as markdown table", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          records: [
            {
              id: "recA",
              createdTime: "2026-01-01T00:00:00Z",
              fields: { Name: "Alice", Score: 95 },
            },
            {
              id: "recB",
              createdTime: "2026-01-01T00:00:00Z",
              fields: { Name: "Bob", Score: 80 },
            },
          ],
        }),
      );
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-read-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Contacts",
        maxRecords: 10,
      });
      expect(result.text).toContain("Alice");
      expect(result.text).toContain("Bob");
      expect(result.text).toContain("recA");
    });

    it("returns no records message", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ records: [] }));
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-read-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Empty",
      });
      expect(result.text).toContain("No records");
    });

    it("includes offset pagination info", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          records: [
            {
              id: "rec1",
              createdTime: "2026-01-01T00:00:00Z",
              fields: { A: "1" },
            },
          ],
          offset: "itr_next",
        }),
      );
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-read-records")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "T",
      });
      expect(result.text).toContain("itr_next");
    });

    it("passes filterByFormula to API", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ records: [] }));
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-read-records")!;
      await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "T",
        filterByFormula: "{Status}='Active'",
      });
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("filterByFormula");
    });
  });

  describe("airtable-list-views", () => {
    it("returns views from a table", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          tables: [
            {
              id: "tblABC",
              name: "Contacts",
              primaryFieldId: "fld1",
              fields: [],
              views: [
                { id: "viw1", name: "Grid view", type: "grid" },
                { id: "viw2", name: "Gallery", type: "gallery" },
              ],
            },
          ],
        }),
      );
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-list-views")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Contacts",
      });
      expect(result.text).toContain("Grid view");
      expect(result.text).toContain("Gallery");
    });

    it("returns error for unknown table", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ tables: [] }));
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-list-views")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Nonexistent",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("not found");
    });
  });

  describe("airtable-get-fields", () => {
    it("returns field schema", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          tables: [
            {
              id: "tblABC",
              name: "Contacts",
              primaryFieldId: "fld1",
              fields: [
                {
                  id: "fld1",
                  name: "Name",
                  type: "singleLineText",
                  description: "Full name",
                },
                { id: "fld2", name: "Email", type: "email" },
              ],
              views: [],
            },
          ],
        }),
      );
      const tools = createAirtableReadTools(mockVault());
      const tool = tools.find((t) => t.name === "airtable-get-fields")!;
      const result = await tool.handler({
        baseId: "appABC123456789",
        tableIdOrName: "Contacts",
      });
      expect(result.text).toContain("Name");
      expect(result.text).toContain("singleLineText");
      expect(result.text).toContain("Email");
    });
  });
});
