import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ToolsPanel } from "./tools-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolInfo } from "@/lib/types";

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const mockGroups: Record<string, ToolInfo[]> = {
  filesystem: [
    { name: "read_file", description: "Read a file", category: "filesystem", riskLevel: "low", enabled: true },
    { name: "write_file", description: "Write a file", category: "filesystem", riskLevel: "high", enabled: false },
  ],
  search: [
    { name: "brave_search", description: "Web search", category: "search", riskLevel: "medium", enabled: true, source: "sidecar" },
  ],
};

describe("ToolsPanel", () => {
  it("renders tool groups and tools", () => {
    render(<ToolsPanel toolGroups={mockGroups} />, { wrapper });

    expect(screen.getByText("filesystem")).toBeInTheDocument();
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("write_file")).toBeInTheDocument();
  });

  it("renders sourced tools in their category", () => {
    render(<ToolsPanel toolGroups={mockGroups} />, { wrapper });

    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("brave_search")).toBeInTheDocument();
  });

  it("shows risk level badges", () => {
    render(<ToolsPanel toolGroups={mockGroups} />, { wrapper });

    expect(screen.getByText("low")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
  });

  it("shows toggle buttons with correct state", () => {
    render(<ToolsPanel toolGroups={mockGroups} />, { wrapper });

    const buttons = screen.getAllByRole("button");
    const onButton = buttons.find((b) => b.textContent === "On");
    const offButton = buttons.find((b) => b.textContent === "Off");

    expect(onButton).toBeTruthy();
    expect(offButton).toBeTruthy();
  });
});
