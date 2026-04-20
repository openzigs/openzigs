import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { ReframePreview } from "./reframe-preview";
import { findBoxAt, SubjectOverlay } from "./subject-overlay";

describe("findBoxAt", () => {
  const boxes = [
    { timestamp: 0, x: 0, y: 0, width: 0.5, height: 0.5 },
    { timestamp: 1, x: 0.1, y: 0, width: 0.5, height: 0.5 },
    { timestamp: 5, x: 0.4, y: 0, width: 0.5, height: 0.5 },
  ];

  it("returns null when boxes empty", () => {
    expect(findBoxAt([], 0)).toBeNull();
  });
  it("clamps to first box for early time", () => {
    expect(findBoxAt(boxes, -10)?.timestamp).toBe(0);
  });
  it("clamps to last box for late time", () => {
    expect(findBoxAt(boxes, 100)?.timestamp).toBe(5);
  });
  it("returns active sample (timestamp <= time)", () => {
    expect(findBoxAt(boxes, 0.5)?.timestamp).toBe(0);
    expect(findBoxAt(boxes, 1)?.timestamp).toBe(1);
    expect(findBoxAt(boxes, 3)?.timestamp).toBe(1);
    expect(findBoxAt(boxes, 5)?.timestamp).toBe(5);
  });
});

describe("SubjectOverlay", () => {
  it("renders nothing when boxes empty", () => {
    const ref = { current: null } as React.RefObject<HTMLVideoElement>;
    const { queryByTestId } = render(
      <SubjectOverlay boxes={[]} videoRef={ref} />,
    );
    expect(queryByTestId("subject-overlay")).toBeNull();
  });

  it("renders an SVG with rect at the box geometry", () => {
    const ref = {
      current: { currentTime: 2 } as HTMLVideoElement,
    } as React.RefObject<HTMLVideoElement>;
    const boxes = [
      { timestamp: 0, x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
      { timestamp: 5, x: 0.3, y: 0.1, width: 0.4, height: 0.5 },
    ];
    const { getByTestId } = render(
      <SubjectOverlay boxes={boxes} videoRef={ref} pollIntervalMs={10} />,
    );
    const svg = getByTestId("subject-overlay");
    const rect = svg.querySelector("rect");
    expect(rect).not.toBeNull();
    expect(rect?.getAttribute("x")).toBe("0.1");
    expect(rect?.getAttribute("width")).toBe("0.5");
  });
});

describe("ReframePreview", () => {
  it("renders source video and a placeholder when no reframed url", () => {
    const { getByTestId, getByText } = render(
      <ReframePreview sourceUrl="blob:foo" caption="Demo" />,
    );
    expect(getByTestId("reframe-source-video")).toHaveAttribute(
      "src",
      "blob:foo",
    );
    expect(getByText("Demo")).toBeInTheDocument();
    expect(getByText("Render preview")).toBeInTheDocument();
  });

  it("renders dual videos when both URLs present", () => {
    const { getByTestId } = render(
      <ReframePreview sourceUrl="blob:src" reframedUrl="blob:re" />,
    );
    expect(getByTestId("reframe-source-video")).toHaveAttribute(
      "src",
      "blob:src",
    );
    expect(getByTestId("reframe-reframed-video")).toHaveAttribute(
      "src",
      "blob:re",
    );
  });

  it("toggles play/pause and forwards calls to both video elements", async () => {
    const playSrc = vi.fn().mockResolvedValue(undefined);
    const pauseSrc = vi.fn();
    const playRe = vi.fn().mockResolvedValue(undefined);
    const pauseRe = vi.fn();
    HTMLMediaElement.prototype.play = function play() {
      return (
        this === document.querySelectorAll("video")[0] ? playSrc() : playRe()
      ) as Promise<void>;
    };
    HTMLMediaElement.prototype.pause = function pause() {
      if (this === document.querySelectorAll("video")[0]) pauseSrc();
      else pauseRe();
    };

    const { getByRole } = render(
      <ReframePreview sourceUrl="blob:src" reframedUrl="blob:re" />,
    );
    const playBtn = getByRole("button", { name: /play preview/i });
    await act(async () => {
      fireEvent.click(playBtn);
    });
    expect(playSrc).toHaveBeenCalled();
    expect(playRe).toHaveBeenCalled();

    const pauseBtn = getByRole("button", { name: /pause preview/i });
    fireEvent.click(pauseBtn);
    expect(pauseSrc).toHaveBeenCalled();
    expect(pauseRe).toHaveBeenCalled();
  });

  it("shows tracking sample count when boxes provided", () => {
    const { getByText } = render(
      <ReframePreview
        sourceUrl="blob:src"
        boxes={[{ timestamp: 0, x: 0, y: 0, width: 0.5, height: 0.5 }]}
      />,
    );
    expect(getByText("1 tracking sample")).toBeInTheDocument();
  });
});
