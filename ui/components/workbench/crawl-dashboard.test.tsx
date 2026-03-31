import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CrawlDashboardDialog } from "./crawl-dashboard";

const mockEmit = vi.fn();

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({
    socket: { connected: true, emit: mockEmit, on: vi.fn(), off: vi.fn() },
    connected: true,
  }),
}));

describe("CrawlDashboardDialog", () => {
  beforeEach(() => {
    mockEmit.mockClear();
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

  it("shows monitor action select when Monitor is selected", () => {
    render(<CrawlDashboardDialog open={true} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByText("Monitor"));
    expect(screen.getByLabelText("Action")).toBeTruthy();
  });

  it("does not render when closed", () => {
    render(<CrawlDashboardDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText("Firecrawl Dashboard")).toBeNull();
  });
});
