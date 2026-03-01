import { describe, expect, it, vi, afterEach } from "vitest";

// Mock the chrome launcher so tests don't try to actually launch Chrome
vi.mock("../../browser/chrome-launcher.js", () => ({
  ensureChromeRunning: vi.fn().mockResolvedValue(true)
}));

vi.mock("../../browser/stealth.js", () => ({
  COMBINED_STEALTH_SCRIPT: "/* stealth */"
}));

import { createBrowserNavigateHandler } from "./browser-navigate.js";

/**
 * Helper: create a FakeWebSocket class that auto-responds to CDP commands.
 * `responder` receives parsed CDP messages and should return the result payload,
 * or undefined to send an empty result.
 */
function makeFakeWebSocket(
  responder: (msg: { id: number; method: string; params?: Record<string, unknown> }) => Record<string, unknown> | undefined
) {
  return class FakeWebSocket {
    callbacks = new Map<string, ((...args: unknown[]) => void)[]>();

    constructor() {
      setTimeout(() => this.emit("open"), 0);
    }

    addEventListener(event: string, cb: (...args: unknown[]) => void) {
      if (!this.callbacks.has(event)) this.callbacks.set(event, []);
      this.callbacks.get(event)!.push(cb);
    }

    removeEventListener() {}

    send(data: string) {
      const parsed = JSON.parse(data);
      setTimeout(() => {
        const responsePayload = responder(parsed) ?? { result: {} };
        this.emit("message", {
          data: JSON.stringify({ id: parsed.id, ...responsePayload })
        });
      }, 5);
    }

    close() {}

    emit(event: string, data?: unknown) {
      this.callbacks.get(event)?.forEach(cb => cb(data));
    }

    /** Emit a CDP event (no id, just method+params) */
    emitCdpEvent(method: string, params: Record<string, unknown> = {}) {
      this.emit("message", {
        data: JSON.stringify({ method, params })
      });
    }
  };
}

/** Stub fetch to return target list, and WebSocket with a CDP responder. */
function stubBrowser(
  responder: (msg: { id: number; method: string; params?: Record<string, unknown> }) => Record<string, unknown> | undefined,
  targets = [{ id: "1", type: "page", title: "P", url: "http://x", webSocketDebuggerUrl: "ws://d" }]
) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => targets
  }));
  const WS = makeFakeWebSocket(responder);
  vi.stubGlobal("WebSocket", WS as unknown as typeof WebSocket);
  return WS;
}

describe("browser-navigate handler", () => {
  afterEach(() => vi.unstubAllGlobals());

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
      callbacks = new Map<string, ((...args: unknown[]) => void)[]>();
      
      constructor(public url: string) {
        setTimeout(() => this.emit("open"), 0);
      }

      addEventListener(event: string, cb: (...args: unknown[]) => void) {
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
  });

  // ────────────────────────────────────────────────────────────────────
  // NEW TESTS: cover untested branches
  // ────────────────────────────────────────────────────────────────────

  it("buildBaseUrl preserves http:// prefix when host already has scheme", async () => {
    const handler = createBrowserNavigateHandler({ host: "http://myhost", port: 9222 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "1", type: "page", title: "T", url: "http://x", webSocketDebuggerUrl: "ws://d" }]
    }));
    const result = await handler({ action: "list-tabs" });
    expect(result.success).toBe(true);
    // fetch should have been called with http://myhost:9222/json/list
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://myhost:9222/json/list");
  });

  it("buildBaseUrl preserves https:// prefix", async () => {
    const handler = createBrowserNavigateHandler({ host: "https://secure", port: 443 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => []
    }));
    const result = await handler({ action: "list-tabs" });
    expect(result.success).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("https://secure:443/json/list");
  });

  it("list-tabs throws on non-ok HTTP response", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(handler({ action: "list-tabs" })).rejects.toThrow(/Chrome DevTools error: 500/);
  });

  it("list-tabs throws on invalid Chrome response schema", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => "not-an-array"
    }));
    await expect(handler({ action: "list-tabs" })).rejects.toThrow(/validation failed/);
  });

  it("list-tabs filters out non-page targets", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "1", type: "page", title: "Page", url: "http://a" },
        { id: "2", type: "background_page", title: "Ext", url: "chrome-extension://x" },
        { id: "3", type: "service_worker", title: "SW", url: "chrome://sw" }
      ]
    }));
    const result = await handler({ action: "list-tabs" });
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs![0].title).toBe("Page");
  });

  it("throws for click without selector", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => undefined);
    await expect(handler({ action: "click" })).rejects.toThrow(/selector is required/i);
  });

  it("throws for type without selector", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => undefined);
    await expect(handler({ action: "type", text: "hello" })).rejects.toThrow(/selector is required/i);
  });

  it("throws for type without text", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => undefined);
    await expect(handler({ action: "type", selector: "#input" })).rejects.toThrow(/text is required/i);
  });

  it("throws for get-text without selector", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => undefined);
    await expect(handler({ action: "get-text" })).rejects.toThrow(/selector is required/i);
  });

  it("throws for evaluate without expression", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => undefined);
    await expect(handler({ action: "evaluate" })).rejects.toThrow(/expression is required/i);
  });

  it("navigate action completes full CDP flow", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    const methods: string[] = [];

    const WS = makeFakeWebSocket((msg) => {
      methods.push(msg.method);
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "string", value: JSON.stringify({ title: "My Page", url: "http://example.com" }) } } };
      }
      return undefined;
    });

    // Patch send to also emit Page.loadEventFired after Page.navigate
    const origSend = WS.prototype.send;
    WS.prototype.send = function (data: string) {
      origSend.call(this, data);
      const parsed = JSON.parse(data);
      if (parsed.method === "Page.navigate") {
        setTimeout(() => this.emitCdpEvent("Page.loadEventFired"), 10);
      }
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "1", type: "page", title: "P", url: "http://x", webSocketDebuggerUrl: "ws://d" }]
    }));
    vi.stubGlobal("WebSocket", WS as unknown as typeof WebSocket);

    const result = await handler({ action: "navigate", url: "http://example.com" });
    expect(result.success).toBe(true);
    expect(result.title).toBe("My Page");
    expect(result.url).toBe("http://example.com");
    expect(methods).toContain("Page.enable");
    expect(methods).toContain("Page.addScriptToEvaluateOnNewDocument");
    expect(methods).toContain("Page.navigate");
    expect(methods).toContain("Runtime.evaluate");
  });

  it("navigate falls back to empty title when evaluate returns non-string", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });

    const WS = makeFakeWebSocket((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "undefined", value: undefined } } };
      }
      return undefined;
    });

    const origSend = WS.prototype.send;
    WS.prototype.send = function (data: string) {
      origSend.call(this, data);
      const parsed = JSON.parse(data);
      if (parsed.method === "Page.navigate") {
        setTimeout(() => this.emitCdpEvent("Page.loadEventFired"), 5);
      }
    };

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ id: "1", type: "page", title: "P", url: "http://x", webSocketDebuggerUrl: "ws://d" }]
    }));
    vi.stubGlobal("WebSocket", WS as unknown as typeof WebSocket);

    const result = await handler({ action: "navigate", url: "http://x.com" });
    expect(result.success).toBe(true);
    expect(result.title).toBe("");
    expect(result.url).toBe("http://x.com");
  });

  it("click action succeeds when element is found", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { clicked: true } } } };
      }
      return undefined;
    });

    const result = await handler({ action: "click", selector: "#btn" });
    expect(result.success).toBe(true);
    expect(result.text).toBe("Clicked #btn");
  });

  it("click action throws when element not found", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { error: "Element not found" } } } };
      }
      return undefined;
    });
    await expect(handler({ action: "click", selector: "#nope" })).rejects.toThrow("Element not found");
  });

  it("type action dispatches key events for each character", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    const dispatched: string[] = [];
    stubBrowser((msg) => {
      if (msg.method === "Input.dispatchKeyEvent") {
        dispatched.push(`${msg.params?.type}:${msg.params?.text}`);
      }
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { focused: true } } } };
      }
      return undefined;
    });

    const result = await handler({ action: "type", selector: "#in", text: "ab" });
    expect(result.success).toBe(true);
    expect(result.text).toBe("Typed into #in");
    expect(dispatched).toEqual(["keyDown:a", "keyUp:a", "keyDown:b", "keyUp:b"]);
  });

  it("type action throws when focus element not found", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { error: "Element not found" } } } };
      }
      return undefined;
    });
    await expect(handler({ action: "type", selector: "#gone", text: "x" })).rejects.toThrow("Element not found");
  });

  it("type action resolves vault SECRET tokens", async () => {
    const resolveToken = vi.fn().mockReturnValue("s3cret");
    const vaultService = { resolveToken } as unknown as import("../../vault/index.js").SecretVaultService;
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222, vaultService });

    const dispatched: string[] = [];
    stubBrowser((msg) => {
      if (msg.method === "Input.dispatchKeyEvent" && msg.params?.type === "keyDown") {
        dispatched.push(String(msg.params.text));
      }
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { focused: true } } } };
      }
      return undefined;
    });

    await handler({ action: "type", selector: "#pw", text: "{{SECRET:12345678-1234-1234-1234-123456789abc}}" });
    expect(resolveToken).toHaveBeenCalledWith("12345678-1234-1234-1234-123456789abc");
    // Should have typed the resolved plaintext characters
    expect(dispatched.join("")).toBe("s3cret");
  });

  it("type action throws when vault secret not found", async () => {
    const resolveToken = vi.fn().mockReturnValue(undefined);
    const vaultService = { resolveToken } as unknown as import("../../vault/index.js").SecretVaultService;
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222, vaultService });

    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { focused: true } } } };
      }
      return undefined;
    });

    await expect(
      handler({ action: "type", selector: "#pw", text: "{{SECRET:00000000-0000-0000-0000-000000000000}}" })
    ).rejects.toThrow(/not found in vault/);
  });

  it("get-text action returns element text content", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { text: "Hello World" } } } };
      }
      return undefined;
    });

    const result = await handler({ action: "get-text", selector: "#title" });
    expect(result.success).toBe(true);
    expect(result.text).toBe("Hello World");
  });

  it("get-text action throws when element not found", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { error: "Element not found" } } } };
      }
      return undefined;
    });
    await expect(handler({ action: "get-text", selector: "#nope" })).rejects.toThrow("Element not found");
  });

  it("screenshot action returns base64 data URI", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Page.captureScreenshot") {
        return { result: { data: "iVBORw0KGgo=" } };
      }
      return undefined;
    });

    const result = await handler({ action: "screenshot" });
    expect(result.success).toBe(true);
    expect(result.screenshot).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("screenshot action handles data at top-level of response", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => {
      // The CDP response has `data` directly, not nested under result.result
      return { data: "abc123" };
    });

    const result = await handler({ action: "screenshot" });
    expect(result.success).toBe(true);
    expect(result.screenshot).toBe("data:image/png;base64,abc123");
  });

  it("screenshot returns empty string when no data is available", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => ({ result: {} }));

    const result = await handler({ action: "screenshot" });
    expect(result.success).toBe(true);
    expect(result.screenshot).toBe("");
  });

  it("evaluate action returns stringified non-string result", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "object", value: { count: 42 } } } };
      }
      return undefined;
    });

    const result = await handler({ action: "evaluate", expression: "({count:42})" });
    expect(result.success).toBe(true);
    expect(result.text).toBe('{"count":42}');
  });

  it("evaluate action returns string result directly", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser((msg) => {
      if (msg.method === "Runtime.evaluate") {
        return { result: { result: { type: "string", value: "hello" } } };
      }
      return undefined;
    });

    const result = await handler({ action: "evaluate", expression: "'hello'" });
    expect(result.success).toBe(true);
    expect(result.text).toBe("hello");
  });

  it("throws for unknown action", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    stubBrowser(() => undefined);
    await expect(
      handler({ action: "unknown-action" as any })
    ).rejects.toThrow(/Unknown browser action/);
  });

  it("getFirstTarget throws when no page targets have webSocketDebuggerUrl", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "1", type: "background_page", title: "BG", url: "chrome://x" }
      ]
    }));
    vi.stubGlobal("WebSocket", class { addEventListener() {} } as unknown as typeof WebSocket);
    await expect(handler({ action: "click", selector: "#a" })).rejects.toThrow(/No page targets/);
  });

  it("getFirstTarget throws on non-ok fetch response", async () => {
    const handler = createBrowserNavigateHandler({ host: "localhost", port: 9222 });
    // First call for list-tabs validation passes, second call (getFirstTarget) fails
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    vi.stubGlobal("WebSocket", class { addEventListener() {} } as unknown as typeof WebSocket);
    await expect(handler({ action: "click", selector: "#a" })).rejects.toThrow(/Chrome DevTools error: 502/);
  });
});
