import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  CrawlProgressPanel,
  CrawlItem,
  formatElapsed,
} from "./crawl-progress-panel";
import type { CrawlStats } from "@/hooks/useCrawlProgress";

// Stub useSocket so the underlying useCrawlProgress hook is inert.
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: null, connected: false }),
  getStableClientId: () => "test-client",
}));
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn().mockResolvedValue({ status: "cancelled" }),
}));

function makeStats(partial: Partial<CrawlStats> = {}): CrawlStats {
  return {
    jobId: "job-1",
    siteUrl: "https://example.com",
    pagesCompleted: 4,
    totalPages: 10,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    status: "running",
    lastUrl: "https://example.com/about",
    errorCount: 0,
    errors: [],
    ...partial,
  };
}

describe("formatElapsed", () => {
  it("formats sub-hour as MM:SS", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(45_000)).toBe("00:45");
    expect(formatElapsed(125_000)).toBe("02:05");
  });
  it("formats over an hour as H:MM:SS", () => {
    expect(formatElapsed(3_661_000)).toBe("1:01:01");
  });
  it("clamps negative values", () => {
    expect(formatElapsed(-50)).toBe("00:00");
  });
});

describe("CrawlProgressPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when there are no crawls", () => {
    const { container } = render(<CrawlProgressPanel crawls={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders site URL, last URL, and pages count for a running crawl", () => {
    render(<CrawlProgressPanel crawls={[makeStats()]} />);
    expect(screen.getByText("https://example.com")).toBeInTheDocument();
    expect(screen.getByText(/example\.com\/about/)).toBeInTheDocument();
    expect(screen.getByText("4/10 pages")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(screen.getByText(/remaining/)).toBeInTheDocument();
  });

  it("exposes ARIA progressbar with correct values", () => {
    render(<CrawlProgressPanel crawls={[makeStats()]} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  it("shows cancel button when running and triggers handler", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<CrawlProgressPanel crawls={[makeStats()]} onCancel={onCancel} />);
    const btn = screen.getByRole("button", { name: /cancel crawl/i });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(onCancel).toHaveBeenCalledWith("job-1");
    });
  });

  it("hides cancel button for terminal states", () => {
    render(
      <CrawlProgressPanel
        crawls={[makeStats({ status: "completed" })]}
        onCancel={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /cancel crawl/i }),
    ).not.toBeInTheDocument();
  });

  it("expands errors list when error badge clicked", () => {
    render(
      <CrawlProgressPanel
        crawls={[
          makeStats({
            errorCount: 2,
            errors: [
              { url: "https://example.com/x", statusCode: 404 },
              { url: "https://example.com/y", statusCode: 500 },
            ],
          }),
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: /2 errors/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("500")).toBeInTheDocument();
  });

  it("calls onComplete when crawl reaches terminal state", () => {
    const onComplete = vi.fn();
    render(
      <CrawlItem
        crawl={makeStats({ status: "completed" })}
        onComplete={onComplete}
      />,
    );
    expect(onComplete).toHaveBeenCalledWith("job-1");
  });

  it("uses default cancel handler when none supplied", async () => {
    const apiMod = await import("@/lib/api");
    render(<CrawlProgressPanel crawls={[makeStats()]} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel crawl/i }));
    await waitFor(() => {
      expect(apiMod.fetchJson).toHaveBeenCalledWith(
        "/api/seo/audit/job-1/cancel",
        { method: "POST" },
      );
    });
  });

  it("shows failed status icon and progress bar style", () => {
    render(
      <CrawlProgressPanel
        crawls={[makeStats({ status: "failed", pagesCompleted: 3 })]}
      />,
    );
    expect(screen.getByLabelText("Failed")).toBeInTheDocument();
  });
});
