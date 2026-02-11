import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AgentsPanel } from "./agents-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CustomAgentDefinition, ToolInfo } from "@/lib/types";

const mockTools: Record<string, ToolInfo[]> = {
  filesystem: [
    { name: "read_file", description: "Read a file", category: "filesystem", riskLevel: "low", enabled: true },
    { name: "write_file", description: "Write a file", category: "filesystem", riskLevel: "high", enabled: true },
  ],
  search: [
    { name: "brave_search", description: "Web search", category: "search", riskLevel: "medium", enabled: true },
  ],
};

const mockAgents: CustomAgentDefinition[] = [
  {
    name: "researcher",
    displayName: "Research Agent",
    description: "Gathers information from the web",
    prompt: "You are a research specialist.",
    tools: ["read_file", "brave_search"],
    infer: true,
  },
  {
    name: "coder",
    displayName: "Coding Agent",
    description: "Writes and reviews code",
    prompt: "You are a coding expert.",
    tools: ["read_file", "write_file"],
    infer: false,
  },
];

const createWrapper = (agents: CustomAgentDefinition[] = [], tools: Record<string, ToolInfo[]> = {}) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["agents"], { agents });
  qc.setQueryData(["tools"], { tools });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "AgentsTestWrapper";
  return Wrapper;
};

describe("AgentsPanel", () => {
  it("shows empty state when no agents defined", () => {
    render(<AgentsPanel />, { wrapper: createWrapper() });

    expect(screen.getByText(/No custom agents defined/)).toBeInTheDocument();
  });

  it("shows agents count", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    expect(screen.getByText("2 agents defined")).toBeInTheDocument();
  });

  it("renders singular count for one agent", () => {
    render(<AgentsPanel />, { wrapper: createWrapper([mockAgents[0]]) });

    expect(screen.getByText("1 agent defined")).toBeInTheDocument();
  });

  it("renders agent cards with display names", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    expect(screen.getByText("Research Agent")).toBeInTheDocument();
    expect(screen.getByText("Coding Agent")).toBeInTheDocument();
  });

  it("shows agent descriptions", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    expect(screen.getByText("Gathers information from the web")).toBeInTheDocument();
    expect(screen.getByText("Writes and reviews code")).toBeInTheDocument();
  });

  it("shows tool badges on agent cards", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    // read_file appears on both agent cards
    expect(screen.getAllByText("read_file")).toHaveLength(2);
    expect(screen.getByText("brave_search")).toBeInTheDocument();
  });

  it("shows auto-invoke badge for agents with infer enabled", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    expect(screen.getByText("Auto-invoke")).toBeInTheDocument();
  });

  it("shows New Agent button", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    expect(screen.getByText("New Agent")).toBeInTheDocument();
  });

  it("shows edit and delete buttons on each card", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents) });

    const editButtons = screen.getAllByText("Edit");
    const deleteButtons = screen.getAllByText("Delete");

    expect(editButtons).toHaveLength(2);
    expect(deleteButtons).toHaveLength(2);
  });

  it("opens create dialog when New Agent is clicked", () => {
    render(<AgentsPanel />, { wrapper: createWrapper([], mockTools) });

    fireEvent.click(screen.getByText("New Agent"));

    expect(screen.getByRole("dialog", { name: /Create Custom Agent/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("researcher")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Research Agent")).toBeInTheDocument();
  });

  it("opens edit dialog when Edit is clicked", () => {
    render(<AgentsPanel />, { wrapper: createWrapper(mockAgents, mockTools) });

    const editButtons = screen.getAllByText("Edit");
    fireEvent.click(editButtons[0]);

    expect(screen.getByRole("dialog", { name: /Edit Custom Agent/i })).toBeInTheDocument();
  });

  it("shows overflow count when agent has more than 5 tools", () => {
    const manyToolsAgent: CustomAgentDefinition = {
      ...mockAgents[0],
      tools: ["t1", "t2", "t3", "t4", "t5", "t6", "t7"],
    };
    render(<AgentsPanel />, { wrapper: createWrapper([manyToolsAgent]) });

    expect(screen.getByText("+2 more")).toBeInTheDocument();
  });
});
