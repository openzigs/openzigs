import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture socket event handlers
const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
const mockSocket = {
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (!handlers[event]) handlers[event] = [];
    handlers[event].push(handler);
  }),
  off: vi.fn(),
};
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

function emit(event: string, data: unknown) {
  for (const h of handlers[event] ?? []) {
    h(data);
  }
}

// Import after mocks
import { SubagentLivePanel } from "./subagent-live-panel";

describe("SubagentLivePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(handlers)) delete handlers[key];
  });

  it("renders nothing when no agents are active", () => {
    const { container } = render(<SubagentLivePanel sessionId="s1" />);
    expect(container.querySelector("[data-testid='subagent-live-panel']")).toBeNull();
  });

  it("subscribes to both task:* and subagent:* socket events", () => {
    render(<SubagentLivePanel sessionId="s1" />);

    const eventNames = mockSocket.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(eventNames).toContain("task:tool-call");
    expect(eventNames).toContain("task:status");
    expect(eventNames).toContain("subagent:started");
    expect(eventNames).toContain("subagent:completed");
    expect(eventNames).toContain("subagent:failed");
    expect(eventNames).toContain("subagent:selected");
    expect(eventNames).toContain("subagent:deselected");
  });

  it("shows panel when subagent:started is emitted for matching session", () => {
    render(<SubagentLivePanel sessionId="s1" />);

    act(() => {
      emit("subagent:started", { sessionId: "s1", agentName: "researcher" });
    });

    expect(screen.getByTestId("subagent-live-panel")).toBeInTheDocument();
    expect(screen.getByText(/Active Agents/)).toBeInTheDocument();
  });

  it("renders filter buttons", () => {
    render(<SubagentLivePanel sessionId="s1" />);

    act(() => {
      emit("subagent:started", { sessionId: "s1", agentName: "coder" });
    });

    expect(screen.getByLabelText("Filter: all")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter: background")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter: in-session")).toBeInTheDocument();
  });

  it("dismisses panel when X is clicked", () => {
    render(<SubagentLivePanel sessionId="s1" />);

    act(() => {
      emit("subagent:started", { sessionId: "s1", agentName: "coder" });
    });

    expect(screen.getByTestId("subagent-live-panel")).toBeInTheDocument();

    // Click dismiss
    const buttons = screen.getAllByRole("button");
    const dismissBtn = buttons.find((b) => b.querySelector(".lucide-x"));
    fireEvent.click(dismissBtn!);

    expect(screen.queryByTestId("subagent-live-panel")).toBeNull();
  });
});
