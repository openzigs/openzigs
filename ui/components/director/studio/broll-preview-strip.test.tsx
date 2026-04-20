import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  BRollCard,
  BRollPreviewStrip,
  type BRollSuggestionView,
} from "./broll-preview-strip";

const sampleSuggestion: BRollSuggestionView = {
  id: "s1",
  timestamp: 12,
  duration: 3.5,
  query: "city skyline",
  thumbnailUrl: "https://example.com/thumb.jpg",
  source: "pexels",
  relevanceScore: 0.78,
};

describe("BRollCard", () => {
  it("renders thumbnail with alt text and score badge", () => {
    render(<BRollCard suggestion={sampleSuggestion} />);
    const img = screen.getByAltText(
      /B-roll thumbnail for city skyline/i,
    ) as HTMLImageElement;
    expect(img.src).toContain("thumb.jpg");
    expect(screen.getByLabelText("Relevance score 78%")).toBeInTheDocument();
  });

  it("renders placeholder when no thumbnailUrl", () => {
    render(
      <BRollCard
        suggestion={{ ...sampleSuggestion, thumbnailUrl: undefined }}
      />,
    );
    expect(screen.getByText("No preview")).toBeInTheDocument();
  });

  it("triggers onAccept and onReject", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(
      <BRollCard
        suggestion={sampleSuggestion}
        onAccept={onAccept}
        onReject={onReject}
      />,
    );
    fireEvent.click(screen.getByLabelText(/accept b-roll/i));
    fireEvent.click(screen.getByLabelText(/reject b-roll/i));
    expect(onAccept).toHaveBeenCalledWith("s1");
    expect(onReject).toHaveBeenCalledWith("s1");
  });

  it("disables the matching button once status is set", () => {
    render(
      <BRollCard suggestion={{ ...sampleSuggestion, status: "accepted" }} />,
    );
    expect(screen.getByLabelText(/accept b-roll/i)).toBeDisabled();
  });

  it("hides score when relevanceScore missing", () => {
    render(
      <BRollCard
        suggestion={{ ...sampleSuggestion, relevanceScore: undefined }}
      />,
    );
    expect(screen.queryByLabelText(/relevance score/i)).not.toBeInTheDocument();
  });
});

describe("BRollPreviewStrip", () => {
  it("renders one marker per suggestion at correct position", () => {
    const totalDuration = 60;
    const suggestions: BRollSuggestionView[] = [
      { ...sampleSuggestion, id: "a", timestamp: 0, duration: 3 },
      { ...sampleSuggestion, id: "b", timestamp: 30, duration: 6 },
    ];
    render(
      <BRollPreviewStrip
        suggestions={suggestions}
        totalDuration={totalDuration}
      />,
    );
    const a = screen.getByTestId("broll-marker-a") as HTMLElement;
    const b = screen.getByTestId("broll-marker-b") as HTMLElement;
    expect(a.style.left).toBe("0%");
    expect(b.style.left).toBe("50%");
    expect(b.style.width).toBe("10%");
  });

  it("returns null for non-positive total duration", () => {
    const { container } = render(
      <BRollPreviewStrip suggestions={[]} totalDuration={0} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("invokes onMarkerClick", () => {
    const onMarkerClick = vi.fn();
    render(
      <BRollPreviewStrip
        suggestions={[sampleSuggestion]}
        totalDuration={60}
        onMarkerClick={onMarkerClick}
      />,
    );
    fireEvent.click(screen.getByTestId("broll-marker-s1"));
    expect(onMarkerClick).toHaveBeenCalledWith("s1");
  });
});
