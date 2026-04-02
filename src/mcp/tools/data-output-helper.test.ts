/**
 * Tests for data-output-helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  writeToOutput,
  outputSummaryLine,
  type OutputTo,
} from "./data-output-helper.js";
import type { SecretVaultService } from "../../vault/secret-vault-service.js";

// ── Mock vault ───────────────────────────────────────────────────────────

function mockVault(
  secrets: Record<string, string> = { "airtable-api-key": "pat_test" },
): SecretVaultService {
  return {
    isUnlocked: () => true,
    getByLabel: (label: string) => secrets[label],
  } as unknown as SecretVaultService;
}

function lockedVault(): SecretVaultService {
  return { isUnlocked: () => false } as unknown as SecretVaultService;
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

describe("writeToOutput", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when outputTo is undefined", async () => {
    const result = await writeToOutput(undefined, [], null);
    expect(result).toBeNull();
  });

  it("returns error when vault is locked (airtable)", async () => {
    const out: OutputTo = {
      type: "airtable",
      baseId: "appXYZ",
      tableIdOrName: "Table1",
    };
    const result = await writeToOutput(out, [{ Name: "Alice" }], lockedVault());
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("Vault is locked");
  });

  it("returns error when vault is locked (sheets)", async () => {
    const out: OutputTo = {
      type: "sheets",
      spreadsheetId: "abc",
      range: "Sheet1!A1",
    };
    const result = await writeToOutput(out, [{ Name: "Alice" }], lockedVault());
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("Vault is locked");
  });

  it("returns error when airtable baseId is missing", async () => {
    const out: OutputTo = { type: "airtable", tableIdOrName: "Table1" };
    const result = await writeToOutput(out, [{ Name: "Alice" }], mockVault());
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("baseId");
  });

  it("returns error when sheets spreadsheetId is missing", async () => {
    const out: OutputTo = { type: "sheets", range: "A1" };
    const result = await writeToOutput(
      out,
      [{ Name: "Alice" }],
      mockVault({ "google-sheets-oauth-token": "tok" }),
    );
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("spreadsheetId");
  });

  it("returns error when no airtable API key", async () => {
    const out: OutputTo = {
      type: "airtable",
      baseId: "appXYZ",
      tableIdOrName: "T",
    };
    const result = await writeToOutput(out, [{ x: 1 }], mockVault({}));
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("airtable-api-key");
  });

  it("returns error when no sheets OAuth token", async () => {
    const out: OutputTo = {
      type: "sheets",
      spreadsheetId: "abc",
      range: "A1",
    };
    const result = await writeToOutput(out, [{ x: 1 }], mockVault({}));
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("google-sheets-oauth-token");
  });

  it("writes rows to Airtable successfully", async () => {
    // First batch response
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        records: [
          { id: "recA", fields: { Name: "Alice" } },
          { id: "recB", fields: { Name: "Bob" } },
        ],
      }),
    );

    const out: OutputTo = {
      type: "airtable",
      baseId: "appABC1234567890",
      tableIdOrName: "Contacts",
    };
    const rows = [{ Name: "Alice" }, { Name: "Bob" }];
    const result = await writeToOutput(out, rows, mockVault());

    expect(result!.success).toBe(true);
    expect(result!.recordsWritten).toBe(2);
    expect(result!.destination).toBe("airtable://appABC1234567890/Contacts");
  });

  it("writes rows to Sheets successfully", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({
        updates: { updatedRows: 3, updatedColumns: 2, updatedCells: 6 },
      }),
    );

    const out: OutputTo = {
      type: "sheets",
      spreadsheetId: "abc",
      range: "Sheet1!A1",
    };
    const rows = [{ Name: "Alice" }, { Name: "Bob" }];
    const result = await writeToOutput(
      out,
      rows,
      mockVault({ "google-sheets-oauth-token": "tok" }),
    );

    expect(result!.success).toBe(true);
    expect(result!.recordsWritten).toBe(3);
    expect(result!.destination).toBe("sheets://abc/Sheet1!A1");
  });

  it("returns error for invalid A1 notation", async () => {
    const out: OutputTo = {
      type: "sheets",
      spreadsheetId: "abc",
      range: "!!!invalid",
    };
    const result = await writeToOutput(
      out,
      [{ x: 1 }],
      mockVault({ "google-sheets-oauth-token": "tok" }),
    );
    expect(result!.success).toBe(false);
    expect(result!.error).toContain("Invalid A1 notation");
  });

  it("handles fetch failure gracefully", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("Network down"));

    const out: OutputTo = {
      type: "airtable",
      baseId: "appABC1234567890",
      tableIdOrName: "Contacts",
    };
    const result = await writeToOutput(out, [{ Name: "Alice" }], mockVault());

    expect(result!.success).toBe(false);
    expect(result!.error).toContain("Network down");
  });

  it("handles empty rows for sheets", async () => {
    const out: OutputTo = {
      type: "sheets",
      spreadsheetId: "abc",
      range: "Sheet1!A1",
    };
    const result = await writeToOutput(
      out,
      [],
      mockVault({ "google-sheets-oauth-token": "tok" }),
    );
    expect(result!.success).toBe(true);
    expect(result!.recordsWritten).toBe(0);
  });
});

describe("outputSummaryLine", () => {
  it("returns empty string for null result", () => {
    expect(outputSummaryLine(null)).toBe("");
  });

  it("returns success line", () => {
    const line = outputSummaryLine({
      success: true,
      recordsWritten: 5,
      destination: "airtable://appXYZ/T",
    });
    expect(line).toContain("5 records");
    expect(line).toContain("airtable://appXYZ/T");
  });

  it("returns failure line", () => {
    const line = outputSummaryLine({
      success: false,
      recordsWritten: 0,
      destination: "sheets://",
      error: "Missing creds",
    });
    expect(line).toContain("Output failed");
    expect(line).toContain("Missing creds");
  });
});
