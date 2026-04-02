/**
 * Tests for SheetsClient, SheetsRateLimiter, and A1 notation validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SheetsClient,
  SheetsRateLimiter,
  validateA1Notation,
} from "./sheets-client.js";

// ── A1 Notation Validation Tests ─────────────────────────────────────────

describe("validateA1Notation", () => {
  it("accepts simple cell references", () => {
    expect(validateA1Notation("A1")).toBe(true);
    expect(validateA1Notation("Z99")).toBe(true);
    expect(validateA1Notation("AA100")).toBe(true);
  });

  it("accepts range references", () => {
    expect(validateA1Notation("A1:B10")).toBe(true);
    expect(validateA1Notation("A1:Z99")).toBe(true);
  });

  it("accepts column ranges", () => {
    expect(validateA1Notation("A:B")).toBe(true);
    expect(validateA1Notation("A:Z")).toBe(true);
  });

  it("accepts row ranges", () => {
    expect(validateA1Notation("1:10")).toBe(true);
  });

  it("accepts sheet-qualified ranges", () => {
    expect(validateA1Notation("Sheet1!A1:B10")).toBe(true);
    expect(validateA1Notation("'My Sheet'!A1:B10")).toBe(true);
  });

  it("accepts absolute references", () => {
    expect(validateA1Notation("$A$1:$B$10")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(validateA1Notation("")).toBe(false);
    expect(validateA1Notation("   ")).toBe(false);
  });

  it("rejects invalid formats", () => {
    expect(validateA1Notation("not-a-range")).toBe(false);
    expect(validateA1Notation("!!!")).toBe(false);
  });
});

// ── SheetsRateLimiter Tests ──────────────────────────────────────────────

describe("SheetsRateLimiter", () => {
  it("allows requests within the rate limit", async () => {
    const limiter = new SheetsRateLimiter(60);
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
    }
  });
});

// ── SheetsClient Tests ───────────────────────────────────────────────────

describe("SheetsClient", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockResponse(data: unknown, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
      headers: new Headers(),
    } as unknown as Response;
  }

  it("throws if neither API key nor access token provided", () => {
    expect(() => new SheetsClient({})).toThrow(
      "requires an API key or OAuth2 access token",
    );
  });

  describe("getSpreadsheet", () => {
    it("returns spreadsheet metadata", async () => {
      const data = {
        spreadsheetId: "abc123",
        properties: { title: "My Sheet" },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Sheet1",
              index: 0,
              sheetType: "GRID",
            },
          },
        ],
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/abc123",
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new SheetsClient({ apiKey: "test-key" });
      const result = await client.getSpreadsheet("abc123");
      expect(result.properties.title).toBe("My Sheet");
      expect(result.sheets).toHaveLength(1);
    });
  });

  describe("getValues", () => {
    it("returns value range", async () => {
      const data = {
        range: "Sheet1!A1:B5",
        majorDimension: "ROWS",
        values: [
          ["Name", "Email"],
          ["Alice", "alice@example.com"],
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new SheetsClient({ apiKey: "test-key" });
      const result = await client.getValues("abc123", "Sheet1!A1:B5");
      expect(result.values).toHaveLength(2);
    });

    it("rejects invalid A1 notation", async () => {
      const client = new SheetsClient({ apiKey: "test-key" });
      await expect(client.getValues("abc123", "invalid")).rejects.toThrow(
        "Invalid A1 notation",
      );
    });

    it("appends API key for read-only requests", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ range: "A1", majorDimension: "ROWS", values: [] }),
      );
      const client = new SheetsClient({ apiKey: "my-api-key" });
      await client.getValues("spreadsheet1", "A1:B5");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("key=my-api-key");
    });
  });

  describe("write operations", () => {
    it("updateValues requires OAuth2 token", async () => {
      const client = new SheetsClient({ apiKey: "read-only-key" });
      await expect(
        client.updateValues("abc123", "A1:B2", [["data"]]),
      ).rejects.toThrow("Write operations require OAuth2");
    });

    it("updateValues sends PUT", async () => {
      const data = {
        spreadsheetId: "abc123",
        updatedRange: "Sheet1!A1:B1",
        updatedRows: 1,
        updatedColumns: 2,
        updatedCells: 2,
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new SheetsClient({ accessToken: "oauth-token" });
      const result = await client.updateValues("abc123", "A1:B1", [["a", "b"]]);
      expect(result.updatedCells).toBe(2);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("PUT");
    });

    it("appendValues sends POST", async () => {
      const data = {
        spreadsheetId: "abc123",
        tableRange: "Sheet1!A1:B5",
        updates: { updatedRows: 1, updatedColumns: 2, updatedCells: 2 },
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new SheetsClient({ accessToken: "oauth-token" });
      const result = await client.appendValues("abc123", "A1:B5", [
        ["new", "row"],
      ]);
      expect(result.updates.updatedRows).toBe(1);
    });

    it("createSpreadsheet creates a new spreadsheet", async () => {
      const data = {
        spreadsheetId: "new123",
        properties: { title: "New Sheet" },
        sheets: [],
        spreadsheetUrl: "https://docs.google.com/spreadsheets/d/new123",
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new SheetsClient({ accessToken: "oauth-token" });
      const result = await client.createSpreadsheet("New Sheet");
      expect(result.spreadsheetId).toBe("new123");
    });

    it("addSheet sends batchUpdate", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ replies: [{}] }));
      const client = new SheetsClient({ accessToken: "oauth-token" });
      await client.addSheet("abc123", "NewTab");
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.requests[0].addSheet.properties.title).toBe("NewTab");
    });

    it("formatCells sends repeatCell request", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ replies: [{}] }));
      const client = new SheetsClient({ accessToken: "oauth-token" });
      await client.formatCells("abc123", 0, 0, 1, 0, 2, { bold: true });
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(init.body as string);
      expect(body.requests[0].repeatCell).toBeDefined();
    });
  });

  describe("listSpreadsheets", () => {
    it("returns files from Drive API", async () => {
      const data = {
        files: [
          {
            id: "abc",
            name: "Test Sheet",
            mimeType: "application/vnd.google-apps.spreadsheet",
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new SheetsClient({ accessToken: "oauth-token" });
      const result = await client.listSpreadsheets();
      expect(result.files).toHaveLength(1);
    });
  });

  describe("error handling", () => {
    it("throws on 400", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: "Bad Request" }, 400),
      );
      const client = new SheetsClient({ apiKey: "key" });
      await expect(client.getSpreadsheet("bad")).rejects.toThrow("bad request");
    });

    it("throws on 401", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: "Unauthorized" }, 401),
      );
      const client = new SheetsClient({ apiKey: "key" });
      await expect(client.getSpreadsheet("x")).rejects.toThrow(
        "authentication failed",
      );
    });

    it("throws on 403", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ error: "Forbidden" }, 403));
      const client = new SheetsClient({ apiKey: "key" });
      await expect(client.getSpreadsheet("x")).rejects.toThrow("access denied");
    });

    it("throws on 404", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ error: "Not Found" }, 404));
      const client = new SheetsClient({ apiKey: "key" });
      await expect(client.getSpreadsheet("x")).rejects.toThrow("not found");
    });

    it("retries on 429", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse({ error: "Rate limit" }, 429))
        .mockResolvedValueOnce(
          mockResponse({
            spreadsheetId: "ok",
            properties: { title: "OK" },
            sheets: [],
            spreadsheetUrl: "",
          }),
        );
      const client = new SheetsClient({ apiKey: "key" });
      const result = await client.getSpreadsheet("ok");
      expect(result.properties.title).toBe("OK");
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("attempts token refresh on 401 with refresh token", async () => {
      // First call: 401
      fetchSpy.mockResolvedValueOnce(mockResponse({}, 401));
      // Token refresh call
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ access_token: "new-token" }),
      );
      // Retry with new token
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "abc",
          properties: { title: "Test" },
          sheets: [],
          spreadsheetUrl: "",
        }),
      );

      const client = new SheetsClient({
        accessToken: "old-token",
        refreshToken: "refresh-123",
        clientId: "client-id",
        clientSecret: "client-secret",
      });

      const result = await client.getSpreadsheet("abc");
      expect(result.properties.title).toBe("Test");
      expect(fetchSpy).toHaveBeenCalledTimes(3); // original + refresh + retry
    });
  });

  describe("auth headers", () => {
    it("sends Bearer token with OAuth2", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "x",
          properties: { title: "" },
          sheets: [],
          spreadsheetUrl: "",
        }),
      );
      const client = new SheetsClient({ accessToken: "bearer-test" });
      await client.getSpreadsheet("x");
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer bearer-test");
    });

    it("does not add key param when OAuth2 token is present", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({
          spreadsheetId: "x",
          properties: { title: "" },
          sheets: [],
          spreadsheetUrl: "",
        }),
      );
      const client = new SheetsClient({ apiKey: "key", accessToken: "token" });
      await client.getSpreadsheet("x");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).not.toContain("key=");
    });
  });
});
