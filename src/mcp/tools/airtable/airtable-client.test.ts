/**
 * Tests for AirtableClient and RateLimiter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AirtableClient, RateLimiter } from "./airtable-client.js";

// ── RateLimiter Tests ────────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within the rate limit", async () => {
    const limiter = new RateLimiter(5);
    // Should resolve immediately for the first 5 requests
    for (let i = 0; i < 5; i++) {
      await limiter.acquire("test");
    }
  });

  it("queues requests exceeding the rate limit", async () => {
    const limiter = new RateLimiter(2);
    const results: number[] = [];
    const start = Date.now();

    // Fire 4 requests — first 2 immediate, next 2 delayed
    const promises = [0, 1, 2, 3].map(async (i) => {
      await limiter.acquire("test");
      results.push(i);
    });

    await Promise.all(promises);
    expect(results).toHaveLength(4);
    // The 3rd and 4th should have waited at least ~900ms
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("tracks separate keys independently", async () => {
    const limiter = new RateLimiter(1);
    // Two different keys should each allow 1 req/sec independently
    await Promise.all([limiter.acquire("key-a"), limiter.acquire("key-b")]);
    expect(limiter.getQueueSize("key-a")).toBe(0);
    expect(limiter.getQueueSize("key-b")).toBe(0);
  });
});

// ── AirtableClient Tests ─────────────────────────────────────────────────

describe("AirtableClient", () => {
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

  it("throws if API key is empty", () => {
    expect(() => new AirtableClient({ apiKey: "" })).toThrow(
      "Airtable API key is required",
    );
  });

  it("validates base ID format", async () => {
    const client = new AirtableClient({ apiKey: "pat_test" });
    await expect(client.listTables("invalid-base-id")).rejects.toThrow(
      "Invalid Airtable base ID",
    );
  });

  describe("listBases", () => {
    it("returns bases from the API", async () => {
      const data = {
        bases: [
          { id: "appABC123456789", name: "My Base", permissionLevel: "edit" },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));

      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.listBases();

      expect(result.bases).toHaveLength(1);
      expect(result.bases[0].name).toBe("My Base");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("/meta/bases");
    });

    it("passes offset parameter", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ bases: [] }));
      const client = new AirtableClient({ apiKey: "pat_test" });
      await client.listBases("itr_cursor");
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("offset=itr_cursor");
    });
  });

  describe("listTables", () => {
    it("returns tables from a base", async () => {
      const data = {
        tables: [
          {
            id: "tblABC",
            name: "Contacts",
            primaryFieldId: "fldXYZ",
            fields: [],
            views: [],
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.listTables("appABC123456789");
      expect(result.tables).toHaveLength(1);
      expect(result.tables[0].name).toBe("Contacts");
    });
  });

  describe("listRecords", () => {
    it("returns records with query parameters", async () => {
      const data = {
        records: [
          {
            id: "recABC",
            createdTime: "2026-01-01T00:00:00.000Z",
            fields: { Name: "Alice" },
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.listRecords("appABC123456789", "Contacts", {
        fields: ["Name", "Email"],
        filterByFormula: "{Status}='Active'",
        maxRecords: 10,
        sort: [{ field: "Name", direction: "asc" }],
      });
      expect(result.records).toHaveLength(1);
      const url = fetchSpy.mock.calls[0][0] as string;
      expect(url).toContain("filterByFormula");
      expect(url).toContain("maxRecords=10");
    });
  });

  describe("createRecords", () => {
    it("creates records with POST", async () => {
      const data = {
        records: [
          {
            id: "recNEW",
            createdTime: "2026-01-01T00:00:00.000Z",
            fields: { Name: "Bob" },
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.createRecords("appABC123456789", "Contacts", [
        { fields: { Name: "Bob" } },
      ]);
      expect(result.records).toHaveLength(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
    });

    it("rejects batches > 10 records", async () => {
      const client = new AirtableClient({ apiKey: "pat_test" });
      const records = Array.from({ length: 11 }, () => ({
        fields: { Name: "X" },
      }));
      await expect(
        client.createRecords("appABC123456789", "Contacts", records),
      ).rejects.toThrow("max 10 records");
    });
  });

  describe("updateRecords", () => {
    it("updates records with PATCH", async () => {
      const data = {
        records: [
          {
            id: "recABC",
            createdTime: "2026-01-01T00:00:00.000Z",
            fields: { Name: "Updated" },
          },
        ],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.updateRecords("appABC123456789", "Contacts", [
        { id: "recABC", fields: { Name: "Updated" } },
      ]);
      expect(result.records).toHaveLength(1);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("PATCH");
    });

    it("rejects batches > 10 records", async () => {
      const client = new AirtableClient({ apiKey: "pat_test" });
      const records = Array.from({ length: 11 }, (_, i) => ({
        id: `rec${i}`,
        fields: { Name: "X" },
      }));
      await expect(
        client.updateRecords("appABC123456789", "Contacts", records),
      ).rejects.toThrow("max 10 records");
    });
  });

  describe("deleteRecords", () => {
    it("deletes records with DELETE", async () => {
      const data = {
        records: [{ id: "recABC", deleted: true }],
      };
      fetchSpy.mockResolvedValueOnce(mockResponse(data));
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.deleteRecords("appABC123456789", "Contacts", [
        "recABC",
      ]);
      expect(result.records[0].deleted).toBe(true);
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("DELETE");
    });

    it("rejects batches > 10 record IDs", async () => {
      const client = new AirtableClient({ apiKey: "pat_test" });
      const ids = Array.from({ length: 11 }, (_, i) => `rec${i}`);
      await expect(
        client.deleteRecords("appABC123456789", "Contacts", ids),
      ).rejects.toThrow("max 10 records");
    });
  });

  describe("error handling", () => {
    it("throws on 401 without retry", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { type: "AUTHENTICATION_REQUIRED" } }, 401),
      );
      const client = new AirtableClient({ apiKey: "pat_bad" });
      await expect(client.listBases()).rejects.toThrow("authentication failed");
    });

    it("throws on 403", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { type: "FORBIDDEN" } }, 403),
      );
      const client = new AirtableClient({ apiKey: "pat_test" });
      await expect(client.listBases()).rejects.toThrow("access denied");
    });

    it("throws on 404", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { type: "NOT_FOUND" } }, 404),
      );
      const client = new AirtableClient({ apiKey: "pat_test" });
      await expect(client.listBases()).rejects.toThrow("not found");
    });

    it("throws on 422", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ error: { type: "INVALID_REQUEST" } }, 422),
      );
      const client = new AirtableClient({ apiKey: "pat_test" });
      await expect(client.listBases()).rejects.toThrow("validation error");
    });

    it("retries on 429 with exponential backoff", async () => {
      fetchSpy
        .mockResolvedValueOnce(
          mockResponse({ error: { type: "RATE_LIMIT" } }, 429),
        )
        .mockResolvedValueOnce(mockResponse({ bases: [] }));
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.listBases();
      expect(result.bases).toHaveLength(0);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("retries on 500 errors", async () => {
      fetchSpy
        .mockResolvedValueOnce(mockResponse({ error: "Internal" }, 500))
        .mockResolvedValueOnce(
          mockResponse({
            bases: [
              { id: "appABC123456789", name: "Test", permissionLevel: "read" },
            ],
          }),
        );
      const client = new AirtableClient({ apiKey: "pat_test" });
      const result = await client.listBases();
      expect(result.bases).toHaveLength(1);
    });

    it("throws after max retries exhausted", { timeout: 30_000 }, async () => {
      fetchSpy.mockResolvedValue(mockResponse({ error: "Server Error" }, 500));
      const client = new AirtableClient({ apiKey: "pat_test" });
      await expect(client.listBases()).rejects.toThrow(
        "Airtable API error 500",
      );
    });
  });

  describe("authorization header", () => {
    it("sends Bearer token", async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ bases: [] }));
      const client = new AirtableClient({ apiKey: "pat_secret123" });
      await client.listBases();
      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer pat_secret123");
    });
  });
});
