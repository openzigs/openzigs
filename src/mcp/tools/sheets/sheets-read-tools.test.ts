/**
 * Tests for Google Sheets read MCP tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSheetsReadTools } from "./sheets-read-tools.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

function mockVault(
  apiKey: string | undefined = "test-key",
  accessToken?: string,
): SecretVaultService {
  return {
    isUnlocked: () => true,
    getByLabel: (label: string) => {
      if (label === "google-sheets-api-key") return apiKey;
      if (label === "google-sheets-oauth-token") return accessToken;
      return undefined;
    },
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

describe("Sheets Read Tools", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates 3 read tools", () => {
    const tools = createSheetsReadTools(mockVault());
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual([
      "sheets-list-spreadsheets",
      "sheets-read-range",
      "sheets-get-metadata",
    ]);
  });

  it("all tools have category=data and riskLevel=low", () => {
    const tools = createSheetsReadTools(mockVault());
    for (const tool of tools) {
      expect(tool.category).toBe("data");
      expect(tool.riskLevel).toBe("low");
    }
  });

  describe("sheets-list-spreadsheets", () => {
    it("returns spreadsheets as markdown table", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          files: [
            {
              id: "abc",
              name: "Sales Data",
              mimeType: "application/vnd.google-apps.spreadsheet",
              modifiedTime: "2026-01-01",
            },
          ],
        }),
      );
      const tools = createSheetsReadTools(mockVault(undefined, "oauth-token"));
      const tool = tools.find((t) => t.name === "sheets-list-spreadsheets")!;
      const result = await tool.handler({});
      expect(result.text).toContain("Sales Data");
      expect(result.text).toContain("abc");
    });
  });

  describe("sheets-read-range", () => {
    it("returns data as markdown table", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          range: "Sheet1!A1:B3",
          majorDimension: "ROWS",
          values: [
            ["Name", "Email"],
            ["Alice", "alice@test.com"],
            ["Bob", "bob@test.com"],
          ],
        }),
      );
      const tools = createSheetsReadTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-read-range")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        range: "Sheet1!A1:B3",
      });
      expect(result.text).toContain("Alice");
      expect(result.text).toContain("bob@test.com");
      expect(result.text).toContain("2 data rows");
    });

    it("handles empty results", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          range: "Sheet1!A1:B1",
          majorDimension: "ROWS",
          values: [],
        }),
      );
      const tools = createSheetsReadTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-read-range")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        range: "A1:B1",
      });
      expect(result.text).toContain("No data");
    });

    it("returns error for invalid A1 notation", async () => {
      const tools = createSheetsReadTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-read-range")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        range: "not-valid-range",
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Invalid A1 notation");
    });
  });

  describe("sheets-get-metadata", () => {
    it("returns spreadsheet metadata", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "abc123",
          properties: { title: "My Sheet" },
          sheets: [
            {
              properties: {
                sheetId: 0,
                title: "Sheet1",
                index: 0,
                sheetType: "GRID",
                gridProperties: { rowCount: 1000, columnCount: 26 },
              },
            },
          ],
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc123",
        }),
      );
      const tools = createSheetsReadTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-get-metadata")!;
      const result = await tool.handler({ spreadsheetId: "abc123" });
      expect(result.text).toContain("My Sheet");
      expect(result.text).toContain("Sheet1");
      expect(result.text).toContain("1000");
    });
  });

  describe("vault errors", () => {
    it("returns error when vault is locked", async () => {
      const vault = {
        isUnlocked: () => false,
      } as unknown as SecretVaultService;
      const tools = createSheetsReadTools(vault);
      const tool = tools.find((t) => t.name === "sheets-read-range")!;
      const result = await tool.handler({ spreadsheetId: "x", range: "A1:B2" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Secret Vault");
    });

    it("returns error when no credentials in vault", async () => {
      const vault = {
        isUnlocked: () => true,
        getByLabel: () => undefined,
      } as unknown as SecretVaultService;
      const tools = createSheetsReadTools(vault);
      const tool = tools.find((t) => t.name === "sheets-read-range")!;
      const result = await tool.handler({ spreadsheetId: "x", range: "A1:B2" });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("No Google Sheets credentials");
    });
  });
});
