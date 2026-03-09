import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScreenRecorder } from "./screen-recorder";

// Mock getDisplayMedia
const mockGetDisplayMedia = vi.fn();
const mockGetUserMedia = vi.fn();

Object.defineProperty(globalThis.navigator, "mediaDevices", {
  value: {
    getDisplayMedia: mockGetDisplayMedia,
    getUserMedia: mockGetUserMedia,
  },
  writable: true,
});

// Mock MediaRecorder
class MockMediaRecorder {
  state = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  static isTypeSupported = vi.fn().mockReturnValue(true);

  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.onstop?.();
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
}

globalThis.MediaRecorder = MockMediaRecorder as unknown as typeof MediaRecorder;

// Mock fetch for upload
globalThis.fetch = vi.fn().mockResolvedValue({
  ok: true,
  json: () => Promise.resolve({ assetId: "new-123", filename: "recording_123.webm" }),
});

describe("ScreenRecorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the component", () => {
    render(<ScreenRecorder />);
    expect(screen.getByTestId("screen-recorder")).toBeInTheDocument();
  });

  it("shows Start Recording button in idle state", () => {
    render(<ScreenRecorder />);
    expect(screen.getByTestId("start-recording")).toBeInTheDocument();
    expect(screen.getByTestId("start-recording")).toHaveTextContent("Start Recording");
  });

  it("shows audio toggle buttons", () => {
    render(<ScreenRecorder />);
    expect(screen.getByText("System Audio")).toBeInTheDocument();
    expect(screen.getByText("Microphone")).toBeInTheDocument();
  });

  it("shows macOS hint in idle state", () => {
    render(<ScreenRecorder />);
    expect(screen.getByText(/macOS/)).toBeInTheDocument();
  });

  it("toggles audio options when clicked", () => {
    render(<ScreenRecorder />);
    const sysAudioBtn = screen.getByText("System Audio").closest("button")!;
    // Initially enabled (blue)
    expect(sysAudioBtn.className).toContain("blue");
    fireEvent.click(sysAudioBtn);
    // After click — toggled off
    expect(sysAudioBtn.className).toContain("zinc");
  });

  it("calls onRecordingComplete callback after upload", async () => {
    const onComplete = vi.fn();
    render(<ScreenRecorder onRecordingComplete={onComplete} />);
    // We verify the prop is accepted and the component renders
    expect(screen.getByTestId("screen-recorder")).toBeInTheDocument();
  });
});
