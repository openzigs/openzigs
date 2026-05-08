import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const fetchJsonMock = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}));

import { CostWidget } from "./cost-widget";

const baseAgg = {
  sessionId: "s1",
  callCount: 0,
  totalActualCost: 0,
  totalWouldHaveCost: 0,
  savedByLocal: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
};

describe("CostWidget", () => {
  beforeEach(() => fetchJsonMock.mockReset());
  afterEach(() => vi.useRealTimers());

  it("shows $0.00 when no calls have been made yet", async () => {
    fetchJsonMock.mockResolvedValueOnce({ aggregate: baseAgg });
    render(<CostWidget sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText(/cost: \$0\.00/)).toBeInTheDocument();
    });
  });

  it("shows the saved-by-local total in green when > 0", async () => {
    fetchJsonMock.mockResolvedValueOnce({
      aggregate: {
        ...baseAgg,
        callCount: 2,
        totalActualCost: 0,
        totalWouldHaveCost: 1.5,
        savedByLocal: 1.5,
      },
    });
    render(<CostWidget sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText(/saved \$1\.50 by going local/)).toBeInTheDocument();
    });
    expect(screen.getByText(/cloud-equiv/)).toBeInTheDocument();
  });

  it("renders an error pill when the request fails", async () => {
    fetchJsonMock.mockRejectedValueOnce(new Error("kapow"));
    render(<CostWidget sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getByText(/cost: error/)).toBeInTheDocument();
    });
  });

  it("renders nothing for empty session id (no fetch)", () => {
    render(<CostWidget sessionId="" />);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("formats tiny costs as cents", async () => {
    fetchJsonMock.mockResolvedValueOnce({
      aggregate: {
        ...baseAgg,
        callCount: 1,
        totalActualCost: 0.005,
        totalWouldHaveCost: 0.01,
        savedByLocal: 0.005,
      },
    });
    render(<CostWidget sessionId="s1" />);
    await waitFor(() => {
      expect(screen.getAllByText(/0\.50/).length).toBeGreaterThan(0);
    });
  });
});
