/**
 * Tests for the Pinterest polling adapter.
 *
 * Note: Pinterest's public REST API v5 does not expose individual pin
 * comments. The poller surfaces save-count deltas and newly created pins
 * as engagement events. These tests verify that behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinterestPollFn } from "./pinterest-poll.js";
import type { IncomingComment } from "./types.js";

const SINCE = "2026-01-01T00:00:00Z";

function jsonResponse(
  body: unknown,
  init: Partial<ResponseInit> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createPinterestPollFn", () => {
  beforeEach(() => {
    vi.stubEnv("PINTEREST_ACCESS_TOKEN", "test-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns empty when access token is missing", async () => {
    vi.unstubAllEnvs();
    const fetchImpl = vi.fn();
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = await poll(SINCE);
    expect(out).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("calls the v5 /pins endpoint with the bearer token", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poll(SINCE);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("https://api.pinterest.com/v5/pins");
    expect(url).toContain("pin_metrics=true");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer test-token",
    });
  });

  it("emits an IncomingComment for a newly created pin after `since`", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: "pin_new",
            created_at: "2026-02-01T10:00:00Z",
            title: "My Fresh Pin",
            pin_metrics: { "90d": { save: 0 } },
          },
        ],
      }),
    );
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const out = (await poll(SINCE)) as IncomingComment[];
    expect(out).toHaveLength(1);
    expect(out[0].platform).toBe("pinterest");
    expect(out[0].postId).toBe("pin_new");
    expect(out[0].commentId).toBe("pin_created_pin_new");
    expect(out[0].text).toContain("My Fresh Pin");
  });

  it("does NOT emit for old pins with zero save delta", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: "pin_old",
            created_at: "2025-01-01T00:00:00Z",
            pin_metrics: { "90d": { save: 5 } },
          },
        ],
      }),
    );
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    // first cycle seeds lastSaveCount, no emission
    expect(await poll(SINCE)).toEqual([]);
    // second cycle with same count → still no emission
    expect(await poll(SINCE)).toEqual([]);
  });

  it("emits a save-delta event when save_count grows between cycles", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "pin_growing",
              created_at: "2025-01-01T00:00:00Z",
              pin_metrics: { "90d": { save: 10 } },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            {
              id: "pin_growing",
              created_at: "2025-01-01T00:00:00Z",
              pin_metrics: { "90d": { save: 13 } },
            },
          ],
        }),
      );
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await poll(SINCE); // seed
    const out = (await poll(SINCE)) as IncomingComment[];
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain("+3 new saves");
    expect(out[0].commentId).toMatch(
      /^pin_saves_pin_growing_\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("handles 429 rate-limit gracefully", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await poll(SINCE)).toEqual([]);
  });

  it("handles non-OK responses gracefully", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("server boom", { status: 500 }));
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await poll(SINCE)).toEqual([]);
  });

  it("handles fetch throwing gracefully", async () => {
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("network down"));
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await poll(SINCE)).toEqual([]);
  });

  it("handles invalid JSON body gracefully", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await poll(SINCE)).toEqual([]);
  });

  it("respects the maxPins option in the query string", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    const poll = createPinterestPollFn({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxPins: 7,
    });
    await poll(SINCE);
    expect(fetchImpl.mock.calls[0][0]).toContain("page_size=7");
  });
});
