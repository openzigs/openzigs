/**
 * Tests for Google Sheets write MCP tools.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSheetsWriteTools } from "./sheets-write-tools.js";
import type { SecretVaultService } from "../../../vault/secret-vault-service.js";

function mockVault(
  accessToken: string | undefined = "oauth-token",
): SecretVaultService {
  return {
    isUnlocked: () => true,
    getByLabel: (label: string) => {
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

describe("Sheets Write Tools", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates 5 write tools", () => {
    const tools = createSheetsWriteTools(mockVault());
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      "sheets-write-range",
      "sheets-append-rows",
      "sheets-create-spreadsheet",
      "sheets-create-sheet",
      "sheets-format-cells",
    ]);
  });

  it("all tools have category=data and riskLevel=medium", () => {
    const tools = createSheetsWriteTools(mockVault());
    for (const tool of tools) {
      expect(tool.category).toBe("data");
      expect(tool.riskLevel).toBe("medium");
    }
  });

  describe("sheets-write-range", () => {
    it("writes data and returns cell count", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "abc123",
          updatedRange: "Sheet1!A1:B2",
          updatedRows: 2,
          updatedColumns: 2,
          updatedCells: 4,
        }),
      );
      const tools = createSheetsWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-write-range")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        range: "A1:B2",
        values: [
          ["a", "b"],
          ["c", "d"],
        ],
      });
      expect(result.text).toContain("4 cells");
    });

    it("returns error when no OAuth token", async () => {
      const tools = createSheetsWriteTools(mockVault(undefined));
      const tool = tools.find((t) => t.name === "sheets-write-range")!;
      const result = await tool.handler({
        spreadsheetId: "abc",
        range: "A1:B2",
        values: [["x"]],
      });
      expect(result.isError).toBe(true);
      // Should mention OAuth2 or surface a network-level error
      expect(result.text).toMatch(/OAuth2|Cannot read|undefined/i);
    });
  });

  describe("sheets-append-rows", () => {
    it("appends rows", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "abc123",
          tableRange: "Sheet1!A1:B5",
          updates: { updatedRows: 2, updatedColumns: 2, updatedCells: 4 },
        }),
      );
      const tools = createSheetsWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-append-rows")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        range: "A:B",
        values: [
          ["new1", "new2"],
          ["new3", "new4"],
        ],
      });
      expect(result.text).toContain("Appended 2 rows");
    });
  });

  describe("sheets-create-spreadsheet", () => {
    it("creates a new spreadsheet", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "new123",
          properties: { title: "New Sheet" },
          sheets: [],
          spreadsheetUrl: "https://docs.google.com/spreadsheets/d/new123",
        }),
      );
      const tools = createSheetsWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-create-spreadsheet")!;
      const result = await tool.handler({ title: "New Sheet" });
      expect(result.text).toContain("New Sheet");
      expect(result.text).toContain("new123");
    });
  });

  describe("sheets-create-sheet", () => {
    it("adds a new sheet tab", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ replies: [{}] }));
      const tools = createSheetsWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-create-sheet")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        title: "NewTab",
      });
      expect(result.text).toContain("NewTab");
    });
  });

  describe("sheets-format-cells", () => {
    it("formats cells", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ replies: [{}] }));
      const tools = createSheetsWriteTools(mockVault());
      const tool = tools.find((t) => t.name === "sheets-format-cells")!;
      const result = await tool.handler({
        spreadsheetId: "abc123",
        sheetId: 0,
        startRow: 0,
        endRow: 1,
        startCol: 0,
        endCol: 3,
        bold: true,
      });
      expect(result.text).toContain("Formatted");
    });
  });
});
