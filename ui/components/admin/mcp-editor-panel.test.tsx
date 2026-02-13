import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { McpEditorPanel } from "./mcp-editor-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NativeMcpServerDefinition } from "@/lib/types";

type ServersRecord = Record<string, NativeMcpServerDefinition>;

const mockServers: ServersRecord = {
  "my-local-server": {
    type: "local",
    command: "node",
    args: ["./server.js"],
    env: { API_KEY: "secret123" },
    timeout: 30000,
  },
  "remote-api": {
    type: "http",
    url: "https://api.example.com/mcp",
    headers: { Authorization: "Bearer token" },
    timeout: 60000,
  },
  "event-stream": {
    type: "sse",
    url: "http://localhost:3100/sse",
  },
};

const createWrapper = (servers: ServersRecord = {}) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["native-mcp-servers"], { servers });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "McpEditorTestWrapper";
  return Wrapper;
};

describe("McpEditorPanel", () => {
  it("shows empty state when no servers configured", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    expect(screen.getByText(/No native MCP servers configured/)).toBeInTheDocument();
  });

  it("shows server count", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    expect(screen.getByText("3 servers configured")).toBeInTheDocument();
  });

  it("shows singular count for one server", () => {
    render(<McpEditorPanel />, {
      wrapper: createWrapper({ "solo": { type: "local", command: "echo" } }),
    });

    expect(screen.getByText("1 server configured")).toBeInTheDocument();
  });

  it("renders server cards with names", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    expect(screen.getByText("my-local-server")).toBeInTheDocument();
    expect(screen.getByText("remote-api")).toBeInTheDocument();
    expect(screen.getByText("event-stream")).toBeInTheDocument();
  });

  it("shows type badges on server cards", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    expect(screen.getByText("local")).toBeInTheDocument();
    expect(screen.getByText("http")).toBeInTheDocument();
    expect(screen.getByText("sse")).toBeInTheDocument();
  });

  it("shows command for local servers", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    // Expand the local server card
    fireEvent.click(screen.getByText("my-local-server"));

    expect(screen.getByText("node ./server.js")).toBeInTheDocument();
  });

  it("shows URL for HTTP servers", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    // Expand the HTTP server card
    fireEvent.click(screen.getByText("remote-api"));

    expect(screen.getByText("https://api.example.com/mcp")).toBeInTheDocument();
  });

  it("shows discovered tool count badges on server cards", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    // Expand all three server cards
    fireEvent.click(screen.getByText("my-local-server"));
    fireEvent.click(screen.getByText("remote-api"));
    fireEvent.click(screen.getByText("event-stream"));

    expect(screen.getAllByText("0 discovered tool(s)")).toHaveLength(3);
  });

  it("shows Add Server button", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    expect(screen.getByText("Add Server")).toBeInTheDocument();
  });

  it("shows edit and remove buttons on each card", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    // Expand all three server cards to reveal Edit/Remove buttons
    fireEvent.click(screen.getByText("my-local-server"));
    fireEvent.click(screen.getByText("remote-api"));
    fireEvent.click(screen.getByText("event-stream"));

    const editButtons = screen.getAllByText("Edit");
    const removeButtons = screen.getAllByText("Remove");

    expect(editButtons).toHaveLength(3);
    expect(removeButtons).toHaveLength(3);
  });

  it("opens create dialog when Add Server is clicked", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Add Server"));

    expect(screen.getByRole("dialog", { name: /Add Native MCP Server/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("my-database")).toBeInTheDocument();
  });

  it("shows type selector in dialog with Local, HTTP, SSE", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Add Server"));

    expect(screen.getByRole("button", { name: /Stdio \(Local\)/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^HTTP$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^SSE$/i })).toBeInTheDocument();
  });

  it("shows command field for local type after advancing to step 2", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Add Server"));
    fireEvent.change(screen.getByPlaceholderText("my-database"), { target: { value: "my-local" } });
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    expect(screen.getByPlaceholderText("npx")).toBeInTheDocument();
    expect(screen.getByText("Command")).toBeInTheDocument();
  });

  it("shows URL field when HTTP type is selected in dialog", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Add Server"));
    fireEvent.change(screen.getByPlaceholderText("my-database"), { target: { value: "my-http" } });
    fireEvent.click(screen.getByRole("button", { name: /^HTTP$/i }));
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    expect(screen.getByText("URL")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("https://my-mcp.example.com/mcp")).toBeInTheDocument();
  });

  it("shows timeout field in dialog", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Add Server"));
    fireEvent.change(screen.getByPlaceholderText("my-database"), { target: { value: "with-timeout" } });
    fireEvent.click(screen.getByRole("button", { name: /^Next$/i }));

    expect(screen.getByText("Timeout (ms)")).toBeInTheDocument();
  });

  it("opens edit dialog when Edit is clicked", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper(mockServers) });

    // Expand the first server card to reveal Edit button
    fireEvent.click(screen.getByText("my-local-server"));

    const editButtons = screen.getAllByText("Edit");
    fireEvent.click(editButtons[0]);

    expect(screen.getByRole("dialog", { name: /Edit Native MCP Server/i })).toBeInTheDocument();
  });

  it("closes dialog when Cancel is clicked", () => {
    render(<McpEditorPanel />, { wrapper: createWrapper() });

    fireEvent.click(screen.getByText("Add Server"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
