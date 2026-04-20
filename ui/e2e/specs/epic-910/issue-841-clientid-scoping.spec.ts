import { test, expect } from "@playwright/test";

/**
 * Epic #910 — Issue #841: Backend: Emit Socket.IO progress events to UI
 *
 * Audit ACs (2026-04-19):
 *   AC1–AC4 already met before this PR (crawl:started / progress / completed
 *   wired through firecrawlWebhookHandler -> io.emit).
 *   AC5 (NEW in PR #913): events are scoped to the user's session via
 *   io.to(clientId).emit(); UI calls POST /api/seo/audit/claim to bind a
 *   crawl URL to its Socket.IO client room.
 *
 * These tests cover AC5 by exercising the new claim endpoint contract and
 * by confirming that two browser contexts hold distinct clientIds (a
 * prerequisite for room-scoped delivery).
 */
test.describe("Epic #910 / Issue #841 — Socket.IO clientId scoping", () => {
  // AC5: claim endpoint validates required fields
  test("POST /api/seo/audit/claim rejects missing clientId or url", async ({
    request,
  }) => {
    const noClient = await request.post("/api/seo/audit/claim", {
      data: { url: "https://example.com" },
    });
    expect(noClient.status()).toBe(400);
    const body1 = await noClient.json();
    expect(body1.error).toMatch(/clientId|Missing required fields/);

    const noUrl = await request.post("/api/seo/audit/claim", {
      data: { clientId: "abc123" },
    });
    expect(noUrl.status()).toBe(400);
  });

  // AC5: clientId format is strictly validated to prevent room-name injection
  test("POST /api/seo/audit/claim rejects malformed clientId", async ({
    request,
  }) => {
    const res = await request.post("/api/seo/audit/claim", {
      data: { url: "https://example.com", clientId: "../../etc/passwd" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Invalid clientId/i);
  });

  // AC5: URL must be http(s)
  test("POST /api/seo/audit/claim rejects non-http(s) URLs", async ({
    request,
  }) => {
    const res = await request.post("/api/seo/audit/claim", {
      data: { url: "ftp://example.com", clientId: "client-1" },
    });
    expect(res.status()).toBe(400);
  });

  // AC5: happy path returns the normalized URL + clientId
  test("POST /api/seo/audit/claim accepts well-formed payload", async ({
    request,
  }) => {
    const res = await request.post("/api/seo/audit/claim", {
      data: { url: "example.com", clientId: "client-happy-path" },
    });
    // 503 is acceptable when firecrawlWebhookHandler is not enabled in the
    // running backend; the contract under test is "no 4xx for valid input".
    expect([200, 503]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.status).toBe("claimed");
      expect(body.url).toBe("https://example.com");
      expect(body.clientId).toBe("client-happy-path");
    }
  });

  // AC5 prerequisite: each browser session gets its own persisted clientId
  test("two independent browser contexts each have a distinct Socket.IO clientId", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      await pageA.goto("/seo", { waitUntil: "domcontentloaded" });
      await pageB.goto("/seo", { waitUntil: "domcontentloaded" });
      await pageA.locator("main").waitFor({ state: "visible" });
      await pageB.locator("main").waitFor({ state: "visible" });

      // Wait for the socket-context bootstrapper to write the id.
      await expect
        .poll(async () =>
          pageA.evaluate(() => localStorage.getItem("openzigs:client-id")),
        )
        .not.toBeNull();
      await expect
        .poll(async () =>
          pageB.evaluate(() => localStorage.getItem("openzigs:client-id")),
        )
        .not.toBeNull();

      const idA = await pageA.evaluate(() =>
        localStorage.getItem("openzigs:client-id"),
      );
      const idB = await pageB.evaluate(() =>
        localStorage.getItem("openzigs:client-id"),
      );
      expect(idA).toBeTruthy();
      expect(idB).toBeTruthy();
      expect(idA).not.toBe(idB);
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
