import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineToolbar } from "./timeline-toolbar";
import { TimelineRuler } from "./timeline-ruler";

// Mock ResizeObserver for canvas tests
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as Record<string, unknown>).ResizeObserver =
  MockResizeObserver;

describe("TimelineToolbar", () => {
  const defaultProps = {
    zoom: 1,
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    snapEnabled: false,
    onToggleSnap: vi.fn(),
    onSplitAtPlayhead: vi.fn(),
    canUndo: true,
    canRedo: false,
    onUndo: vi.fn(),
    onRedo: vi.fn(),
  };

  it("renders all controls", () => {
    render(<TimelineToolbar {...defaultProps} />);
    expect(screen.getByTestId("timeline-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-undo")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-redo")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-split")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-snap")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-zoom-out")).toBeInTheDocument();
  });

  it("shows zoom level", () => {
    render(<TimelineToolbar {...defaultProps} zoom={1.5} />);
    expect(screen.getByTestId("timeline-zoom-level").textContent).toBe("150%");
  });

  it("calls onSplitAtPlayhead when split button clicked", () => {
    render(<TimelineToolbar {...defaultProps} />);
    fireEvent.click(screen.getByTestId("timeline-split"));
    expect(defaultProps.onSplitAtPlayhead).toHaveBeenCalled();
  });

  it("calls onUndo when undo button clicked", () => {
    render(<TimelineToolbar {...defaultProps} />);
    fireEvent.click(screen.getByTestId("timeline-undo"));
    expect(defaultProps.onUndo).toHaveBeenCalled();
  });

  it("disables redo when canRedo is false", () => {
    render(<TimelineToolbar {...defaultProps} canRedo={false} />);
    expect(screen.getByTestId("timeline-redo")).toBeDisabled();
  });

  it("calls onToggleSnap when snap button clicked", () => {
    render(<TimelineToolbar {...defaultProps} />);
    fireEvent.click(screen.getByTestId("timeline-snap"));
    expect(defaultProps.onToggleSnap).toHaveBeenCalled();
  });

  it("highlights snap button when enabled", () => {
    render(<TimelineToolbar {...defaultProps} snapEnabled={true} />);
    const snapBtn = screen.getByTestId("timeline-snap");
    expect(snapBtn.className).toContain("text-blue-400");
  });
});

describe("TimelineRuler", () => {
  it("renders canvas element", () => {
    render(
      <TimelineRuler
        totalFrames={900}
        fps={30}
        currentFrame={0}
        zoom={1}
        onSeek={vi.fn()}
      />,
    );
    expect(screen.getByTestId("timeline-ruler")).toBeInTheDocument();
  });
});
