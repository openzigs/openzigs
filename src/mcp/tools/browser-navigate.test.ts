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

  it("returns DOM snapshot via Runtime.evaluate", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    
    // 1. Mock Fetch for target discovery
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "1", type: "page", title: "Page", url: "http://test", webSocketDebuggerUrl: "ws://debug" }
      ]
    });
    vi.stubGlobal("fetch", fetchMock);

    // 2. Mock WebSocket for CDP interaction
    let receivedMessage: string | undefined;
    
    const WebSocketMock = class FakeWebSocket {
      callbacks = new Map<string, Function[]>();
      
      constructor(public url: string) {
        setTimeout(() => this.emit("open"), 0);
      }

      addEventListener(event: string, cb: Function) {
        if (!this.callbacks.has(event)) this.callbacks.set(event, []);
        this.callbacks.get(event)?.push(cb);
      }
      
      removeEventListener() {}
      
      send(data: string) {
        receivedMessage = data;
        const parsed = JSON.parse(data);
        
        // Reply asynchronously
        setTimeout(() => {
          if (parsed.method === "Runtime.evaluate") {
            const resultValue = 'button "Submit" => #submit\na "Link" => body > div > a';
            this.emit("message", {
              data: JSON.stringify({
                id: parsed.id,
                result: {
                  result: {
                    type: "string",
                    value: resultValue
                  }
                }
              })
            });
          }
        }, 10);
      }
      
      close() {}
      
      emit(event: string, data?: unknown) {
        this.callbacks.get(event)?.forEach(cb => cb(data));
      }
    };

    vi.stubGlobal("WebSocket", WebSocketMock as unknown as typeof WebSocket);

    // 3. Execute
    const result = await handler({ action: "snapshot-dom" });
    
    expect(result.success).toBe(true);
    expect(result.text).toContain('button "Submit" => #submit');
    expect(receivedMessage).toContain("Runtime.evaluate");
    
    vi.unstubAllGlobals();
  });
});
