import type { Page, Locator } from "@playwright/test";

/**
 * Page Object for the Admin → Remote Media Worker Nodes panel.
 * Backs Epic #1086 / Sub-issue #1092 (Remote Nodes admin UI).
 *
 * The panel is a collapsed `SectionCard` titled "Remote Media Worker Nodes"
 * mounted on /admin. Each `NodeCard` renders a heading with the node label,
 * URL/token inputs, an "Allow LAN" checkbox, and Test/Save/Reset buttons.
 */

export type NodeFixture = {
  nodeType: string;
  url: string | null;
  hasToken: boolean;
  allowLan: boolean;
  defaultPort: number;
  envVar?: string | null;
};

export const NODE_LABELS = {
  "image-gen": "Image Generation",
  "video-gen": "Video Generation",
  "music-gen": "Music Generation",
  rvc: "RVC Voice Conversion",
  "lip-sync": "Lip Sync",
} as const;

export type NodeKey = keyof typeof NODE_LABELS;

export const ALL_NODE_TYPES: NodeKey[] = [
  "image-gen",
  "video-gen",
  "music-gen",
  "rvc",
  "lip-sync",
];

export class RemoteNodesPage {
  readonly page: Page;
  readonly adminHeading: Locator;
  readonly sectionToggle: Locator;
  readonly panelDescription: Locator;

  constructor(page: Page) {
    this.page = page;
    this.adminHeading = page.getByRole("heading", { name: "Administration" });
    this.sectionToggle = page.getByRole("button", {
      name: "Remote Media Worker Nodes",
    });
    this.panelDescription = page.getByText(
      "Configure remote media worker nodes",
    );
  }

  async goto() {
    await this.page.goto("/admin");
    await this.page.waitForLoadState("domcontentloaded");
    await this.adminHeading.waitFor({ state: "visible", timeout: 15_000 });
  }

  async expandSection() {
    await this.sectionToggle.scrollIntoViewIfNeeded();
    await this.sectionToggle.click();
    await this.panelDescription.waitFor({ state: "visible", timeout: 5_000 });
  }

  /** Return a Locator scoping every interaction to a single node card. */
  card(nodeType: NodeKey): Locator {
    const label = NODE_LABELS[nodeType];
    return this.page
      .locator("div.border.rounded-md")
      .filter({ has: this.page.getByRole("heading", { name: label }) });
  }

  urlInput(nodeType: NodeKey): Locator {
    return this.card(nodeType).getByRole("textbox", { name: "Node URL" });
  }

  tokenInput(nodeType: NodeKey): Locator {
    // Token input has no label association in the DOM; it sits inside the
    // "Secret Token" label. Locate by its placeholder, which is stable.
    return this.card(nodeType).locator(
      'input[placeholder="Bearer token"], input[placeholder="Leave blank to keep"]',
    );
  }

  allowLanCheckbox(nodeType: NodeKey): Locator {
    return this.card(nodeType).getByRole("checkbox", {
      name: /Allow LAN/i,
    });
  }

  saveButton(nodeType: NodeKey): Locator {
    return this.card(nodeType).getByRole("button", { name: "Save" });
  }

  testButton(nodeType: NodeKey): Locator {
    return this.card(nodeType).getByRole("button", {
      name: /Test Connection/i,
    });
  }

  resetButton(nodeType: NodeKey): Locator {
    return this.card(nodeType).getByRole("button", { name: "Reset" });
  }

  // ─── Backend mocks ────────────────────────────────────────────────────

  /**
   * Stub the tools query used by the rest of the admin page so it doesn't
   * fall through to the real backend during tests.
   */
  async mockSupportingAdminApis() {
    await this.page.route("**/api/admin/tools", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ tools: {} }),
      }),
    );
    await this.page.route("**/api/admin/platform", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          platform: {
            os: "darwin",
            arch: "arm64",
            dockerAvailable: false,
            sidecarsSupported: true,
            isWindows: false,
            isMacOS: true,
            isLinux: false,
          },
          features: {
            imageGeneration: { available: true },
            audioProcessing: { available: true },
            musicGeneration: { available: true },
            videoRendering: { available: true },
            docker: { available: false },
          },
        }),
      }),
    );
  }

  /** Mock GET /api/admin/remote-nodes with the supplied node list. */
  async mockNodeList(nodes: NodeFixture[]) {
    await this.page.route("**/api/admin/remote-nodes", (route) => {
      if (route.request().method() !== "GET") {
        return route.fallback();
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ nodes }),
      });
    });
  }

  /**
   * Mock PUT /api/admin/remote-nodes/:nodeType.
   * `responder` returns the response (status + JSON body) per request.
   */
  async mockSave(
    responder: (
      nodeType: string,
      body: Record<string, unknown>,
    ) => { status: number; body: unknown },
  ) {
    await this.page.route(
      /\/api\/admin\/remote-nodes\/[^/]+$/,
      async (route) => {
        const req = route.request();
        if (req.method() !== "PUT") return route.fallback();
        const nodeType = req.url().split("/").pop() ?? "";
        const body = req.postDataJSON?.() ?? JSON.parse(req.postData() ?? "{}");
        const { status, body: out } = responder(nodeType, body);
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(out),
        });
      },
    );
  }

  /** Mock DELETE /api/admin/remote-nodes/:nodeType. */
  async mockDelete(onDelete?: (nodeType: string) => void) {
    await this.page.route(
      /\/api\/admin\/remote-nodes\/[^/]+$/,
      async (route) => {
        const req = route.request();
        if (req.method() !== "DELETE") return route.fallback();
        const nodeType = req.url().split("/").pop() ?? "";
        onDelete?.(nodeType);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true }),
        });
      },
    );
  }

  /** Mock POST /api/admin/remote-nodes/:nodeType/test. */
  async mockTest(
    responder: (nodeType: string) => { status: number; body: unknown },
  ) {
    await this.page.route(
      /\/api\/admin\/remote-nodes\/[^/]+\/test$/,
      async (route) => {
        const req = route.request();
        if (req.method() !== "POST") return route.fallback();
        const parts = req.url().split("/");
        const nodeType = parts[parts.length - 2] ?? "";
        const { status, body } = responder(nodeType);
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      },
    );
  }
}
