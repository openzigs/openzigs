import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import RoadmapEditor from "./roadmap";

const baseSlide = {
  template: "roadmap" as const,
  content: {
    heading: "Plan",
    columns: ["Q1", "Q2"],
    tracks: ["Web"],
    items: [{ column: 0, track: 0, label: "Ship", status: "planned" as const }],
  },
};

describe("RoadmapEditor", () => {
  it("renders heading + columns + tracks + items sections", () => {
    render(<RoadmapEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-rm-heading")).toBeInTheDocument();
    expect(screen.getByTestId("prop-rm-column-0")).toBeInTheDocument();
    expect(screen.getByTestId("prop-rm-track-0")).toBeInTheDocument();
    expect(screen.getByTestId("prop-rm-item-0-label")).toBeInTheDocument();
    expect(screen.getByTestId("prop-rm-item-0-status")).toBeInTheDocument();
  });

  it("editing the heading dispatches onChange", () => {
    const onChange = vi.fn();
    render(<RoadmapEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-rm-heading"), {
      target: { value: "2026 Plan" },
    });
    expect(onChange.mock.calls[0][0].content.heading).toBe("2026 Plan");
  });

  it("changing item status dispatches the enum value", () => {
    const onChange = vi.fn();
    render(<RoadmapEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-rm-item-0-status"), {
      target: { value: "done" },
    });
    expect(onChange.mock.calls[0][0].content.items[0].status).toBe("done");
  });

  it("removing a column drops items pointing at it and shifts higher indices down", () => {
    const onChange = vi.fn();
    render(
      <RoadmapEditor
        slide={{
          ...baseSlide,
          content: {
            ...baseSlide.content,
            columns: ["Q1", "Q2", "Q3"],
            items: [
              { column: 0, track: 0, label: "A" },
              { column: 1, track: 0, label: "B" },
              { column: 2, track: 0, label: "C" },
            ],
          },
        }}
        onChange={onChange}
        deckId="d"
      />,
    );
    fireEvent.click(screen.getByTestId("prop-rm-column-1-remove"));
    const next = onChange.mock.calls[0][0].content;
    expect(next.columns).toEqual(["Q1", "Q3"]);
    // B (column 1) was removed; C (was column 2) shifts to column 1.
    expect(next.items.map((i: { label: string; column: number }) => [i.label, i.column])).toEqual([
      ["A", 0],
      ["C", 1],
    ]);
  });
});
