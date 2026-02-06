import { describe, expect, it, vi } from "vitest";
import { createChromeDevtoolsHandler } from "./chrome-devtools.js";

type WebSocketMessageHandler = (id: number) => Record<string, unknown>;
type SocketMessage = { data: string };

const createWebSocketMock = (handler: WebSocketMessageHandler) => {
  return class FakeWebSocket {
    private listeners = new Map<string, Array<(event?: SocketMessage) => void>>();

    constructor(public url: string) {
      queueMicrotask(() => this.emit("open"));
    }

    addEventListener(event: string, callback: (event?: SocketMessage) => void) {
      const current = this.listeners.get(event) ?? [];
      current.push(callback);
      this.listeners.set(event, current);
    }

    removeEventListener(event: string, callback: (event?: SocketMessage) => void) {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(
        event,
        current.filter((listener) => listener !== callback)
      );
    }

    send(message: string) {
      const payload = JSON.parse(message) as { id: number; method: string };
      if (payload.method !== "Runtime.evaluate") {
        return;
      }
      const response = handler(payload.id);
      queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
    }

    close() {
      this.emit("close");
    }

    private emit(event: string, payload?: SocketMessage) {
      const listeners = this.listeners.get(event) ?? [];
      for (const listener of listeners) {
        listener(payload);
      }
    }
  };
};

describe("chrome devtools handler", () => {
  it("throws when CHROME_DEBUG_HOST is missing", async () => {
    const handler = createChromeDevtoolsHandler({ host: "", port: 9222 });
    await expect(handler({})).rejects.toThrow(/CHROME_DEBUG_HOST/i);
  });

  it("throws when Chrome response validation fails", async () => {
    const handler = createChromeDevtoolsHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ not: "an array" })
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(handler({})).rejects.toThrow(/response validation failed/i);

    vi.unstubAllGlobals();
  });

  it("returns selector text when a match exists", async () => {
    const handler = createChromeDevtoolsHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ title: "Tab", url: "https://example.com", webSocketDebuggerUrl: "ws://debug" }]
    });

    const WebSocketMock = createWebSocketMock((id) => ({
      id,
      result: { result: { value: { text: "Hello" } } }
    }));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", WebSocketMock as unknown as typeof WebSocket);

    await expect(handler({ selector: "h1" })).resolves.toEqual({ text: "Hello" });

    vi.unstubAllGlobals();
  });

  it("returns selector not found when no match exists", async () => {
    const handler = createChromeDevtoolsHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ title: "Tab", url: "https://example.com", webSocketDebuggerUrl: "ws://debug" }]
    });

    const WebSocketMock = createWebSocketMock((id) => ({
      id,
      result: { result: { value: { missing: true } } }
    }));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", WebSocketMock as unknown as typeof WebSocket);

    await expect(handler({ selector: "h1" })).rejects.toThrow(/selector not found/i);

    vi.unstubAllGlobals();
  });

  it("returns an error for invalid selectors", async () => {
    const handler = createChromeDevtoolsHandler({ host: "localhost", port: 9222 });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ title: "Tab", url: "https://example.com", webSocketDebuggerUrl: "ws://debug" }]
    });

    const WebSocketMock = createWebSocketMock((id) => ({
      id,
      result: { result: { value: { error: "SyntaxError" } } }
    }));

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", WebSocketMock as unknown as typeof WebSocket);

    await expect(handler({ selector: "[" })).rejects.toThrow(/invalid selector/i);

    vi.unstubAllGlobals();
  });
});







































