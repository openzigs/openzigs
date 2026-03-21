import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SubagentInlineView } from "./subagent-inline-view";
import type { SubagentEntry } from "@/lib/hooks/use-subagent-events";

const makeEntry = (overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  agentName: "researcher",
  status: "running",
  startedAt: Date.now(),
  ...overrides,
});

describe("SubagentInlineView", () => {
  it("renders nothing when entries are empty", () => {
    const { container } = render(<SubagentInlineView entries={[]} />);
    expect(container.querySelector("[data-testid='subagent-inline-view']")).toBeNull();
  });

  it("renders a section for each subagent entry", () => {
    const entries = [
      makeEntry({ agentName: "researcher" }),
      makeEntry({ agentName: "coder", status: "completed", summary: "Done" }),
    ];
    render(<SubagentInlineView entries={entries} />);
    const sections = screen.getAllByTestId("subagent-section");
    expect(sections).toHaveLength(2);
  });

  it("shows running state with spinner indicator", () => {
    render(<SubagentInlineView entries={[makeEntry({ status: "running" })]} />);
    expect(screen.getByText("researcher")).toBeInTheDocument();
  });

  it("shows completed state with summary", () => {
    const entry = makeEntry({ status: "completed", summary: "Found 5 results" });
    render(<SubagentInlineView entries={[entry]} />);
    expect(screen.getByText("done")).toBeInTheDocument();
  });

  it("shows failed state with error", () => {
    const entry = makeEntry({ status: "failed", error: "Timeout reached" });
    render(<SubagentInlineView entries={[entry]} />);
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("toggles expand/collapse on click", () => {
    const entry = makeEntry({ status: "completed", summary: "Found results" });
    render(<SubagentInlineView entries={[entry]} />);

    // Completed entries default to collapsed
    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Found results")).toBeInTheDocument();

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("has correct aria-label for accessibility", () => {
    render(<SubagentInlineView entries={[makeEntry()]} />);
    expect(screen.getByRole("region", { name: /subagent: researcher/i })).toBeInTheDocument();
  });
});
