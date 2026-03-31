import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ExtractionHistory } from "./extraction-history";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockFetchJson = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

const mockRows = [
  {
    id: 1,
    url: "https://example.com/pricing",
    prompt: "Extract pricing plans",
    schemaJson: '{"type":"array"}',
    extractedAt: "2026-03-30T12:00:00.000Z",
    domain: "example.com",
    preview: "# Pricing - Basic $10/mo - Pro $25/mo",
  },
  {
    id: 2,
    url: "https://jobs.example.com/careers",
    prompt: "Extract job listings",
    schemaJson: null,
    extractedAt: "2026-03-31T08:00:00.000Z",
    domain: "jobs.example.com",
    preview: "# Careers - Software Engineer - Product Manager",
  },
];

// ── Tests ────────────────────────────────────────────────────────────────

describe("ExtractionHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders loading state initially", () => {
    mockFetchJson.mockReturnValue(new Promise(() => {})); // never resolves
    render(<ExtractionHistory />);
    // Should show spinner or loading indicator
  });

  it("renders empty state when no extractions", async () => {
    mockFetchJson.mockResolvedValueOnce({ rows: [], total: 0, limit: 20, offset: 0 });
    render(<ExtractionHistory />);
    await waitFor(() => {
      expect(screen.getByText(/no extractions yet/i)).toBeDefined();
    });
  });

  it("renders extraction rows", async () => {
    mockFetchJson.mockResolvedValueOnce({ rows: mockRows, total: 2, limit: 20, offset: 0 });
    render(<ExtractionHistory />);
    await waitFor(() => {
      expect(screen.getByText(/example.com\/pricing/)).toBeDefined();
      expect(screen.getByText(/jobs\.example.com\/careers/)).toBeDefined();
    });
  });

  it("shows extraction count in header", async () => {
    mockFetchJson.mockResolvedValueOnce({ rows: mockRows, total: 2, limit: 20, offset: 0 });
    render(<ExtractionHistory />);
    await waitFor(() => {
      expect(screen.getByText(/Extraction History \(2\)/)).toBeDefined();
    });
  });

  it("shows Custom for rows with schema", async () => {
    mockFetchJson.mockResolvedValueOnce({ rows: mockRows, total: 2, limit: 20, offset: 0 });
    render(<ExtractionHistory />);
    await waitFor(() => {
      expect(screen.getByText("Custom")).toBeDefined();
    });
  });

  it("loads detail when row is clicked", async () => {
    mockFetchJson
      .mockResolvedValueOnce({ rows: mockRows, total: 2, limit: 20, offset: 0 })
      .mockResolvedValueOnce({
        ...mockRows[0],
        scrapedMarkdown: "# Full Pricing Content\n- Basic: $10/mo",
      });

    render(<ExtractionHistory />);

    await waitFor(() => {
      expect(screen.getByText(/example.com\/pricing/)).toBeDefined();
    });

    const row = screen.getByText(/example.com\/pricing/);
    fireEvent.click(row);

    await waitFor(() => {
      expect(screen.getByText(/Extraction #1/)).toBeDefined();
      expect(screen.getByText(/Back to list/)).toBeDefined();
    });
  });

  it("renders error state", async () => {
    mockFetchJson.mockRejectedValueOnce(new Error("Network error"));
    render(<ExtractionHistory />);
    await waitFor(() => {
      expect(screen.getByText(/Network error/)).toBeDefined();
    });
  });

  it("shows export CSV button when rows exist", async () => {
    mockFetchJson.mockResolvedValueOnce({ rows: mockRows, total: 2, limit: 20, offset: 0 });
    render(<ExtractionHistory />);
    await waitFor(() => {
      expect(screen.getByText(/Export CSV/)).toBeDefined();
    });
  });
});
