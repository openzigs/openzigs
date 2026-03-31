import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CrawlDashboardDialog } from "./crawl-dashboard";

const mockEmit = vi.fn();

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({
    socket: { connected: true, emit: mockEmit, on: vi.fn(), off: vi.fn() },
    connected: true,
  }),
}));

const mockFetchJson = vi.fn();
vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

describe("CrawlDashboardDialog", () => {
  beforeEach(() => {
    mockEmit.mockClear();
    mockFetchJson.mockReset();
    mockFetchJson.mockResolvedValue({ enabled: true });
  });

  it("renders dialog title when open", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByText("Firecrawl Dashboard")).toBeTruthy();
  });

  it("renders three action buttons", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByText("Site Audit")).toBeTruthy();
    expect(screen.getByText("Ingest")).toBeTruthy();
    expect(screen.getByText("Monitor")).toBeTruthy();
  });

  it("shows URL input field", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    expect(screen.getByPlaceholderText("https://example.com")).toBeTruthy();
  });

  it("shows error when URL is empty and submit clicked", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Run Audit"));
    expect(screen.getByText("URL is required")).toBeTruthy();
  });

  it("sends message on submit with valid URL", () => {
    const onOpenChange = vi.fn();
    render(<CrawlDashboardDialog open={true} onOpenChange={onOpenChange} />);

    const urlInput = screen.getByPlaceholderText("https://example.com");
    fireEvent.change(urlInput, { target: { value: "https://example.com" } });
    fireEvent.click(screen.getByText("Run Audit"));

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls[0][0]).toBe("chat:message");
    expect(mockEmit.mock.calls[0][1].content).toContain("seo-site-audit");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("changes button text when switching to Ingest action", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Ingest"));
    expect(screen.getByText("Start Ingestion")).toBeTruthy();
  });

  it("shows category and visibility selects for ingest action", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Ingest"));
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.getByLabelText("Visibility")).toBeTruthy();
  });

  it("includes General option in category dropdown", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Ingest"));
    const categorySelect = screen.getByLabelText("Category") as HTMLSelectElement;
    const options = Array.from(categorySelect.options).map((o) => o.value);
    expect(options).toContain("general");
    expect(options[0]).toBe("general");
  });

  it("shows monitor action select when Monitor is selected", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Monitor"));
    expect(screen.getByLabelText("Action")).toBeTruthy();
  });

  it("does not render when closed", () => {
    render(<CrawlDashboardDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText("Firecrawl Dashboard")).toBeNull();
  });

  it("shows disabled banner when firecrawl is not enabled", async () => {
    mockFetchJson.mockResolvedValue({ enabled: false });
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Firecrawl is not configured")).toBeTruthy();
    });
  });

  it("disables submit button when firecrawl is not enabled", async () => {
    mockFetchJson.mockResolvedValue({ enabled: false });
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      const submitBtn = screen.getByText("Run Audit").closest("button")!;
      expect(submitBtn.disabled).toBe(true);
    });
  });

  it("does not show disabled banner when firecrawl is enabled", async () => {
    mockFetchJson.mockResolvedValue({ enabled: true });
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledWith("/api/admin/firecrawl/status");
    });
    expect(screen.queryByText("Firecrawl is not configured")).toBeNull();
  });

  it("treats fetch failure as disabled", async () => {
    mockFetchJson.mockRejectedValue(new Error("network"));
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("Firecrawl is not configured")).toBeTruthy();
    });
  });
});
