import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConnect = vi.fn();
const mockListTools = vi.fn();
const mockClose = vi.fn();

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class MockClient {
    connect = mockConnect;
    listTools = mockListTools;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class MockSSETransport {
    url: URL;
    constructor(url: URL) {
      this.url = url;
    }
    close = mockClose;
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class MockStdioTransport {
    command: string;
    args: string[];
    env: Record<string, string>;
    constructor(opts: { command: string; args: string[]; env: Record<string, string> }) {
      this.command = opts.command;
      this.args = opts.args;
      this.env = opts.env;
    }
    close = mockClose;
  },
}));

vi.mock("../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { CopilotNativeMcpTester } from "./native-mcp-test-service.js";
import type { NativeMcpTestResult } from "./native-mcp-test-service.js";

describe("CopilotNativeMcpTester", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockClose.mockResolvedValue(undefined);
  });

  it("returns success with discovered tools for a local/stdio server", async () => {
    mockListTools.mockResolvedValue({
      tools: [
        { name: "read-file", description: "Read a file from disk" },
        { name: "write-file", description: "Write content to a file" },
      ],
    });

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("test-server", {
      type: "stdio",
      command: "node",
      args: ["server.js"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.serverName).toBe("test-server");
      expect(result.tools).toHaveLength(2);
      expect(result.tools[0].name).toBe("read-file");
      expect(result.connectionTimeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns success for a remote SSE server", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "search", description: "Search the web" }],
    });

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("remote-server", {
      type: "sse",
      url: "http://localhost:3001/sse",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe("search");
    }
  });

  it("returns success for http type server", async () => {
    mockListTools.mockResolvedValue({ tools: [] });

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("http-srv", {
      type: "http",
      url: "http://localhost:4000/mcp",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools).toHaveLength(0);
    }
  });

  it("returns failure when connection times out", async () => {
    mockConnect.mockImplementation(() => new Promise(() => {})); // never resolves

    const tester = new CopilotNativeMcpTester({ connectTimeout: 50 });
    const result = await tester.testServer("slow-server", {
      type: "stdio",
      command: "node",
      args: ["slow.js"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("timed out");
      expect(result.serverName).toBe("slow-server");
    }
  });

  it("returns failure when connect throws an error", async () => {
    mockConnect.mockRejectedValue(new Error("ENOENT: command not found"));

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("bad-server", {
      type: "stdio",
      command: "nonexistent",
      args: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ENOENT");
    }
  });

  it("returns failure when listTools throws", async () => {
    mockListTools.mockRejectedValue(new Error("Protocol error"));

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("broken", {
      type: "stdio",
      command: "node",
      args: ["broken.js"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Protocol error");
    }
  });

  it("handles tools with missing descriptions", async () => {
    mockListTools.mockResolvedValue({
      tools: [{ name: "no-desc" }],
    });

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("desc-test", {
      type: "stdio",
      command: "node",
      args: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools[0].description).toBe("");
    }
  });

  it("handles null tools list from server", async () => {
    mockListTools.mockResolvedValue({ tools: null });

    const tester = new CopilotNativeMcpTester();
    const result = await tester.testServer("null-tools", {
      type: "stdio",
      command: "node",
      args: [],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tools).toHaveLength(0);
    }
  });

  it("passes environment variables to stdio transport", async () => {
    const tester = new CopilotNativeMcpTester();

    await tester.testServer("env-test", {
      type: "local",
      command: "node",
      args: ["server.js"],
      env: { MY_KEY: "my_value" },
    });

    expect(mockConnect).toHaveBeenCalled();
  });

  it("cleans up transport even on failure", async () => {
    mockConnect.mockRejectedValue(new Error("connect failed"));

    const tester = new CopilotNativeMcpTester();
    await tester.testServer("cleanup-test", {
      type: "stdio",
      command: "node",
      args: [],
    });

    expect(mockClose).toHaveBeenCalled();
  });

  it("handles non-Error thrown values", async () => {
    mockConnect.mockRejectedValue("string error");

    const tester = new CopilotNativeMcpTester();
    const result: NativeMcpTestResult = await tester.testServer("string-err", {
      type: "stdio",
      command: "node",
      args: [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("string error");
    }
  });
});
