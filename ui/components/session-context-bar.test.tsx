import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  ContextGauge,
  SessionIdChip,
  CompactionSpinner,
  SessionContextBar,
} from "./session-context-bar";
import type { SessionStatus } from "@/lib/types";

const baseStatus: SessionStatus = {
  sessionId: "abc12345-long-session-id",
  contextUsage: 0.45,
  turnCount: 12,
  createdAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
  isResumed: false,
  compactionActive: false,
  infiniteSessionsEnabled: false,
};

describe("ContextGauge", () => {
  it("renders the percentage", () => {
    render(<ContextGauge usage={0.72} />);
    expect(screen.getByText("72%")).toBeInTheDocument();
  });

  it("renders Context: label", () => {
    render(<ContextGauge usage={0.5} />);
    expect(screen.getByText("Context:")).toBeInTheDocument();
  });
});

describe("SessionIdChip", () => {
  it("renders truncated session ID", () => {
    render(<SessionIdChip sessionId="abc12345-long-session-id" />);
    expect(screen.getByText("abc12345…")).toBeInTheDocument();
  });

  it("copies to clipboard on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(<SessionIdChip sessionId="full-session-id" />);
    fireEvent.click(screen.getByRole("button", { name: /copy session id/i }));
    expect(writeText).toHaveBeenCalledWith("full-session-id");
  });
});

describe("CompactionSpinner", () => {
  it("renders nothing when not active", () => {
    const { container } = render(<CompactionSpinner active={false} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders spinner when active", () => {
    render(<CompactionSpinner active={true} />);
    expect(screen.getByText("Compacting")).toBeInTheDocument();
  });
});

describe("SessionContextBar", () => {
  it("renders nothing when status is null", () => {
    const { container } = render(<SessionContextBar status={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders session info", () => {
    render(<SessionContextBar status={baseStatus} />);
    expect(screen.getByText("Session:")).toBeInTheDocument();
    expect(screen.getByText("abc12345…")).toBeInTheDocument();
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("12 turns")).toBeInTheDocument();
  });

  it("renders singular turn label for 1 turn", () => {
    render(
      <SessionContextBar status={{ ...baseStatus, turnCount: 1 }} />
    );
    expect(screen.getByText("1 turn")).toBeInTheDocument();
  });

  it("shows compaction spinner when active", () => {
    render(
      <SessionContextBar status={{ ...baseStatus, compactionActive: true }} />
    );
    expect(screen.getByText("Compacting")).toBeInTheDocument();
  });
});
