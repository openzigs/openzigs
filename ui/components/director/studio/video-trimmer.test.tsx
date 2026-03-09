import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VideoTrimmer } from "./video-trimmer";

// Mock socket context
vi.mock("@/lib/socket-context", () => ({
  useSocket: () => null,
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
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("video-trimmer")).toBeInTheDocument();
  });

  it("displays the total duration", () => {
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByText("2:00.0")).toBeInTheDocument();
  });

  it("shows start and end time inputs", () => {
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("start-time-input")).toBeInTheDocument();
    expect(screen.getByTestId("end-time-input")).toBeInTheDocument();
  });

  it("initializes start=0 and end=duration", () => {
    render(<VideoTrimmer {...defaultProps} />);
    const startInput = screen.getByTestId("start-time-input") as HTMLInputElement;
    const endInput = screen.getByTestId("end-time-input") as HTMLInputElement;
    expect(Number(startInput.value)).toBe(0);
    expect(Number(endInput.value)).toBe(120);
  });

  it("shows Export Cut button", () => {
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("trim-button")).toBeInTheDocument();
    expect(screen.getByTestId("trim-button")).toHaveTextContent("Export Cut");
  });

  it("shows Ask AI button", () => {
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("analyze-button")).toBeInTheDocument();
    expect(screen.getByTestId("analyze-button")).toHaveTextContent("Ask AI");
  });

  it("shows Play Selection button", () => {
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByText("Play Selection")).toBeInTheDocument();
  });

  it("updates start time when input changes", () => {
    render(<VideoTrimmer {...defaultProps} />);
    const startInput = screen.getByTestId("start-time-input") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "10" } });
    expect(Number(startInput.value)).toBe(10);
  });

  it("updates end time when input changes", () => {
    render(<VideoTrimmer {...defaultProps} />);
    const endInput = screen.getByTestId("end-time-input") as HTMLInputElement;
    fireEvent.change(endInput, { target: { value: "90" } });
    expect(Number(endInput.value)).toBe(90);
  });

  it("has timeline drag handles", () => {
    render(<VideoTrimmer {...defaultProps} />);
    expect(screen.getByTestId("start-handle")).toBeInTheDocument();
    expect(screen.getByTestId("end-handle")).toBeInTheDocument();
  });

  it("shows selection duration", () => {
    render(<VideoTrimmer {...defaultProps} />);
    // Full duration selected: 120s = 2:00.0
    expect(screen.getByText(/Selection:/)).toBeInTheDocument();
  });
});
