import { describe, expect, it, vi } from "vitest";

// Mock the chrome launcher so tests don't try to actually launch Chrome
vi.mock("../../browser/chrome-launcher.js", () => ({
  ensureChromeRunning: vi.fn().mockResolvedValue(true)
}));

import { createBrowserNavigateHandler } from "./browser-navigate.js";

describe("browser-navigate handler", () => {
  it("throws when CHROME_DEBUG_HOST is missing", async () => {
    const handler = createBrowserNavigateHandler({ host: "", port: 9222 });
    await expect(handler({ action: "list-tabs" })).rejects.toThrow(/CHROME_DEBUG_HOST/i);
  });

  it("lists tabs from Chrome DevTools JSON endpoint", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "1", type: "page", title: "Google", url: "https://google.com", webSocketDebuggerUrl: "ws://debug" },
        { id: "2", type: "page", title: "GitHub", url: "https://github.com", webSocketDebuggerUrl: "ws://debug2" }
      ]
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ action: "list-tabs" });
    expect(result.success).toBe(true);
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs![0].title).toBe("Google");
    expect(result.tabs![1].title).toBe("GitHub");

    vi.unstubAllGlobals();
  });

  it("throws for navigate without url", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "1", type: "page", title: "Tab", url: "https://example.com", webSocketDebuggerUrl: "ws://debug" }
      ]
    });

    // Stub WebSocket to prevent real connection
    const WebSocketMock = class FakeWebSocket {
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() {}
      constructor() {
        queueMicrotask(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const listeners = (this as any)._open ?? [];
          for (const l of listeners) l();
        });
      }
    };

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", WebSocketMock as unknown as typeof WebSocket);

    await expect(handler({ action: "navigate" })).rejects.toThrow(/url is required/i);

    vi.unstubAllGlobals();
  });
});
