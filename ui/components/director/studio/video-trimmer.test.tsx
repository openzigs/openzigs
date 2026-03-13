import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VideoTrimmer } from "./video-trimmer";

function renderWithQueryClient(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

// Mock socket context
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: null, connected: false }),
}));

// Mock fetch / fetchJson
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn().mockResolvedValue({ jobId: "trim-123" }),
  buildMediaUrl: (url: string) => url,
}));

// Mock showToast
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

describe("VideoTrimmer", () => {
  const defaultProps = {
    assetId: "asset-001",
    videoUrl: "/api/queue/assets/asset-001/file",
    duration: 120,
  };

  it("renders the trimmer component", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("video-trimmer")).toBeInTheDocument();
  });

  it("displays the total duration", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByText("2:00.0")).toBeInTheDocument();
  });

  it("shows start and end time inputs", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("start-time-input")).toBeInTheDocument();
    expect(screen.getByTestId("end-time-input")).toBeInTheDocument();
  });

  it("initializes start=0 and end=duration", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    const startInput = screen.getByTestId("start-time-input") as HTMLInputElement;
    const endInput = screen.getByTestId("end-time-input") as HTMLInputElement;
    expect(Number(startInput.value)).toBe(0);
    expect(Number(endInput.value)).toBe(120);
  });

  it("shows Export Cut button", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("trim-button")).toBeInTheDocument();
    expect(screen.getByTestId("trim-button")).toHaveTextContent("Export Cut");
  });

  it("shows Ask AI button", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("analyze-button")).toBeInTheDocument();
    expect(screen.getByTestId("analyze-button")).toHaveTextContent("Ask AI");
  });

  it("shows Play Selection button", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByText("Loop")).toBeInTheDocument();
  });

  it("updates start time when input changes", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    const startInput = screen.getByTestId("start-time-input") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "10" } });
    expect(Number(startInput.value)).toBe(10);
  });

  it("updates end time when input changes", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    const endInput = screen.getByTestId("end-time-input") as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: "90" } });
    expect(Number(endInput.value)).toBe(90);
  });

  it("has timeline drag handles", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("start-handle")).toBeInTheDocument();
    expect(screen.getByTestId("end-handle")).toBeInTheDocument();
  });

  it("shows selection duration", () => {
    renderWithQueryClient(<VideoTrimmer {...defaultProps} />);
    // Full duration selected: 120s = 2:00.0
    expect(screen.getByText(/Selection:/)).toBeInTheDocument();
  });
});
