import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentSelector } from "./agent-selector";

// Mock fetchJson
const mockFetchJson = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
  buildUrl: (p: string) => p,
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

const fakeAgents = [
  { name: "researcher", displayName: "Researcher", description: "Web research", prompt: "", infer: true },
  { name: "coder", displayName: "Coder", description: "Code generation", prompt: "", infer: false },
];

describe("AgentSelector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when no agents are available", async () => {
    mockFetchJson.mockResolvedValue({ agents: [] });
    const { container } = render(<AgentSelector sessionId="s1" />);
    await waitFor(() => expect(mockFetchJson).toHaveBeenCalledWith("/api/admin/agents"));
    expect(container.querySelector("[data-testid='agent-selector']")).toBeNull();
  });

  it("renders the selector when agents are loaded", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ agents: fakeAgents })
      .mockResolvedValueOnce({ agentName: null });

    render(<AgentSelector sessionId="s1" />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-selector")).toBeInTheDocument();
    });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("fetches session agent on mount", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ agents: fakeAgents })
      .mockResolvedValueOnce({ agentName: "researcher" });

    render(<AgentSelector sessionId="s1" />);

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith("/api/admin/sessions/s1/agent");
    });
  });

  it("is disabled when sessionId is null", async () => {
    mockFetchJson.mockResolvedValueOnce({ agents: fakeAgents });

    render(<AgentSelector sessionId={null} />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-selector")).toBeInTheDocument();
    });

    const trigger = screen.getByRole("combobox");
    expect(trigger).toBeDisabled();
  });

  it("does not fetch session agent when sessionId is null", async () => {
    mockFetchJson.mockResolvedValueOnce({ agents: fakeAgents });

    render(<AgentSelector sessionId={null} />);

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledTimes(1);
    });
    expect(mockFetchJson).not.toHaveBeenCalledWith(expect.stringContaining("/sessions/"));
  });
});
