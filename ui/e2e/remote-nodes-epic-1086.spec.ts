import { test, expect } from "./helpers";
import {
  RemoteNodesPage,
  ALL_NODE_TYPES,
  NODE_LABELS,
  type NodeFixture,
} from "./pages/remote-nodes.page";

/**
 * E2E tests for Admin → Remote Media Worker Nodes panel.
 * Backs Epic #1086 (Remote Media Worker Nodes via Cloudflare Tunnel) and
 * Sub-issue #1092 (Admin UI panel).
 *
 * Acceptance Criteria Coverage (#1092):
 * | # | Criterion                                                              | Test                                                              |
 * |---|------------------------------------------------------------------------|-------------------------------------------------------------------|
 * | 1 | Open /admin → Remote Nodes; all 5 node types listed (token masked)     | should list every supported node type with current configuration  |
 * | 2 | Save URL+token; config updates and panel re-fetches                    | should save URL/token/allowLan and refresh the node list          |
 * | 3 | http://169.254.169.254/ rejected with SSRF inline error                | should reject link-local URL with SSRF error message              |
 * | 4 | LAN URL with allowLan=false rejected with toggle-required error        | should reject LAN URL when Allow LAN toggle is off                |
 * | 5 | Test Connection on reachable node shows green health/capabilities      | should report reachable node as green on Test Connection          |
 * | 5b| Test Connection on unreachable node shows red                          | should report unreachable node as red on Test Connection          |
 * | 6 | Reset clears URL/token and reverts to local default                    | should reset a configured node to local default                   |
 * |   | Image-gen panel reflects remote configuration when present (Epic #1086)| should show network mode in Image Gen panel when configured remote |
 *
 * All backend interactions are mocked via page.route() so tests do not depend
 * on a live worker, real DNS, or a writable user config file.
 */

const baseNodes = (
  overrides: Partial<Record<string, Partial<NodeFixture>>> = {},
): NodeFixture[] =>
  ALL_NODE_TYPES.map((nodeType, idx) => ({
    nodeType,
    url: null,
    hasToken: false,
    allowLan: false,
    defaultPort: 5005 + idx,
    envVar: null,
    ...overrides[nodeType],
  }));

test.describe("Admin → Remote Nodes Panel (Epic #1086 / #1092)", () => {
  let panel: RemoteNodesPage;

  test.beforeEach(async ({ page }) => {
    panel = new RemoteNodesPage(page);
    await panel.mockSupportingAdminApis();
  });

  // ── AC1: Panel lists every supported node type ────────────────────────
  test("should list every supported node type with current configuration", async () => {
    await panel.mockNodeList(
      baseNodes({
        "image-gen": {
          url: "https://fluxq.example.com",
          hasToken: true,
          allowLan: false,
        },
      }),
    );

    await panel.goto();
    await panel.expandSection();

    for (const nodeType of ALL_NODE_TYPES) {
      const card = panel.card(nodeType);
      await expect(card).toBeVisible();
      await expect(
        card.getByRole("heading", { name: NODE_LABELS[nodeType] }),
      ).toBeVisible();
    }

    // Configured node prefills its URL into the textbox.
    await expect(panel.urlInput("image-gen")).toHaveValue(
      "https://fluxq.example.com",
    );
    // Token is masked: the input is empty and labelled "(configured)".
    await expect(panel.tokenInput("image-gen")).toHaveValue("");
    await expect(
      panel.card("image-gen").getByText("(configured)"),
    ).toBeVisible();

    // Token input is a password field — never plain text on first render.
    await expect(panel.tokenInput("image-gen")).toHaveAttribute(
      "type",
      "password",
    );
  });

  // ── AC2: Save round-trip ──────────────────────────────────────────────
  test("should save URL/token/allowLan and refresh the node list", async ({
    page,
  }) => {
    let saveBody: Record<string, unknown> | null = null;
    let listFetches = 0;

    await page.route("**/api/admin/remote-nodes", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      listFetches += 1;
      const nodes =
        listFetches === 1
          ? baseNodes()
          : baseNodes({
              "music-gen": {
                url: "https://music.example.com",
                hasToken: true,
              },
            });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes }),
      });
    });

    await panel.mockSave((nodeType, body) => {
      saveBody = { nodeType, ...body };
      return {
        status: 200,
        body: {
          ok: true,
          nodeType,
          url: body.url,
          hasToken: true,
          allowLan: body.allowLan,
        },
      };
    });

    await panel.goto();
    await panel.expandSection();

    await panel.urlInput("music-gen").fill("https://music.example.com");
    await panel.tokenInput("music-gen").fill("super-secret");
    await panel.saveButton("music-gen").click();

    await expect(page.getByText(/Music Generation saved/i)).toBeVisible();

    // The saved payload matches the form values.
    expect(saveBody).toMatchObject({
      nodeType: "music-gen",
      url: "https://music.example.com",
      token: "super-secret",
      allowLan: false,
    });

    // The list query was re-fetched, and the new URL is now reflected.
    await expect(panel.urlInput("music-gen")).toHaveValue(
      "https://music.example.com",
    );
    expect(listFetches).toBeGreaterThanOrEqual(2);
  });

  // ── AC3: SSRF — link-local addresses are blocked ─────────────────────
  test("should reject link-local URL with SSRF error message", async ({
    page,
  }) => {
    await panel.mockNodeList(baseNodes());
    await panel.mockSave(() => ({
      status: 400,
      body: {
        error: "ssrf_blocked",
        message: "Blocked: link-local address (SSRF protection)",
      },
    }));

    await panel.goto();
    await panel.expandSection();

    await panel.urlInput("image-gen").fill("http://169.254.169.254/");
    await panel.saveButton("image-gen").click();

    await expect(
      page.getByText(/Save failed:.*Blocked: link-local address/i),
    ).toBeVisible();
  });

  // ── AC4: LAN URL without Allow LAN toggle is rejected ─────────────────
  test("should reject LAN URL when Allow LAN toggle is off", async ({
    page,
  }) => {
    await panel.mockNodeList(baseNodes());
    await panel.mockSave((_nodeType, body) => {
      if (body.allowLan === true) {
        return { status: 200, body: { ok: true } };
      }
      return {
        status: 400,
        body: {
          error: "lan_not_allowed",
          message:
            "URL points to a private network. Enable 'Allow LAN' to use it.",
        },
      };
    });

    await panel.goto();
    await panel.expandSection();

    const checkbox = panel.allowLanCheckbox("video-gen");
    await expect(checkbox).not.toBeChecked();

    await panel.urlInput("video-gen").fill("http://192.168.68.60:5006");
    await panel.saveButton("video-gen").click();

    await expect(
      page.getByText(/Save failed:.*private network/i),
    ).toBeVisible();
  });

  // ── AC5: Test Connection — reachable node ─────────────────────────────
  test("should report reachable node as green on Test Connection", async () => {
    await panel.mockNodeList(
      baseNodes({
        "image-gen": {
          url: "https://fluxq.example.com",
          hasToken: true,
        },
      }),
    );
    await panel.mockTest(() => ({
      status: 200,
      body: {
        ok: true,
        health: { ok: true, status: 200, body: { status: "ok" } },
        capabilities: {
          ok: true,
          status: 200,
          body: { models: ["flux-dev"] },
        },
      },
    }));

    await panel.goto();
    await panel.expandSection();
    await panel.testButton("image-gen").click();

    const card = panel.card("image-gen");
    await expect(card.getByText(/^OK \(200\)$/).first()).toBeVisible();
    await expect(card.getByText("/health:")).toBeVisible();
    await expect(card.getByText("/capabilities:")).toBeVisible();
  });

  // ── AC5b: Test Connection — unreachable node ─────────────────────────
  test("should report unreachable node as red on Test Connection", async () => {
    await panel.mockNodeList(
      baseNodes({
        rvc: { url: "https://rvc.example.com", hasToken: true },
      }),
    );
    await panel.mockTest(() => ({
      status: 200,
      body: {
        ok: false,
        health: { ok: false, error: "ECONNREFUSED" },
        capabilities: { ok: false, error: "ECONNREFUSED" },
      },
    }));

    await panel.goto();
    await panel.expandSection();
    await panel.testButton("rvc").click();

    const card = panel.card("rvc");
    await expect(card.getByText(/FAIL \(ECONNREFUSED\)/).first()).toBeVisible();
  });

  // ── AC6: Reset clears configuration ───────────────────────────────────
  test("should reset a configured node to local default", async ({ page }) => {
    let listFetches = 0;
    let deleted: string | null = null;

    await page.route("**/api/admin/remote-nodes", (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      listFetches += 1;
      const nodes =
        deleted === "lip-sync"
          ? baseNodes()
          : baseNodes({
              "lip-sync": {
                url: "https://lipsync.example.com",
                hasToken: true,
              },
            });
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes }),
      });
    });

    await panel.mockDelete((nodeType) => {
      deleted = nodeType;
    });

    await panel.goto();
    await panel.expandSection();

    // Reset button is only rendered when the node is configured.
    await expect(panel.resetButton("lip-sync")).toBeVisible();
    await panel.resetButton("lip-sync").click();

    await expect(page.getByText(/Lip Sync reset to local/i)).toBeVisible();
    expect(deleted).toBe("lip-sync");

    // After reset the URL input is cleared and the Reset button disappears
    // because the node is no longer configured.
    await expect(panel.urlInput("lip-sync")).toHaveValue("");
    await expect(panel.resetButton("lip-sync")).toHaveCount(0);
    expect(listFetches).toBeGreaterThanOrEqual(2);
  });

  // ── Cross-panel: Image Gen panel reflects remote configuration ────────
  test("should show network mode in Image Gen panel when configured remote", async ({
    page,
  }) => {
    await panel.mockNodeList(baseNodes());
    await page.route("**/api/admin/image-gen/config", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "network",
          networkNodeUrl: "https://fluxq.example.com",
          networkNodeToken: "",
          hasToken: true,
        }),
      }),
    );

    await panel.goto();

    // Open the Image Generation Node SectionCard.
    const imageGenToggle = page.getByRole("button", {
      name: /Image Generation Node/i,
    });
    await imageGenToggle.scrollIntoViewIfNeeded();
    await imageGenToggle.click();

    // The "Network Node" mode button should be selected — the panel renders
    // the URL input prefilled with the saved remote URL.
    await expect(
      page.getByRole("button", { name: "Network Node" }),
    ).toBeVisible();
    // The placeholder confirms we're in the network-config block, and the
    // value is prefilled from the remote-nodes config.
    await expect(page.getByPlaceholder("http://192.168.1.50:5005")).toHaveValue(
      "https://fluxq.example.com",
    );
  });
});
