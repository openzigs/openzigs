import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: () => null,
}));

import ChartEditor from "./chart";

const baseSlide = {
  template: "chart" as const,
  content: {
    heading: "Sales",
    chart_type: "bar" as const,
    series: [{ name: "Q1", data: [{ x: "a", y: 1 }] }],
  },
};

describe("ChartEditor", () => {
  it("renders the existing series JSON in the textarea", () => {
    render(<ChartEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    const ta = screen.getByTestId("prop-chart-series") as HTMLTextAreaElement;
    expect(JSON.parse(ta.value)).toEqual(baseSlide.content.series);
  });

  it("emits onChange with parsed series for valid JSON", () => {
    const onChange = vi.fn();
    render(<ChartEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    const ta = screen.getByTestId("prop-chart-series");
    fireEvent.change(ta, {
      target: {
        value: JSON.stringify([
          { name: "New", data: [{ x: "z", y: 9 }] },
        ]),
      },
    });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.content.series[0].name).toBe("New");
  });

  it("surfaces a validation error and does NOT emit onChange for malformed JSON", () => {
    const onChange = vi.fn();
    render(<ChartEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-chart-series"), {
      target: { value: "not-json" },
    });
    expect(screen.getByTestId("prop-chart-series-error")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects series whose shape is wrong", () => {
    const onChange = vi.fn();
    render(<ChartEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-chart-series"), {
      target: { value: JSON.stringify([{ name: "x" }]) },
    });
    expect(screen.getByTestId("prop-chart-series-error")).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits onChange when the heading is edited", () => {
    const onChange = vi.fn();
    render(<ChartEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-chart-heading"), {
      target: { value: "Quarterly" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.heading).toBe("Quarterly");
  });

  it.each([
    ["non-array root", "{}", /array/i],
    ["non-object item", JSON.stringify(["x"]), /object/i],
    ["bad data shape", JSON.stringify([{ name: "x", data: "x" }]), /array/i],
    [
      "bad point shape",
      JSON.stringify([{ name: "x", data: [{ x: "ok" }] }]),
      /point/i,
    ],
  ])("rejects series for %s", (_label, text, msgPattern) => {
    const onChange = vi.fn();
    render(<ChartEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-chart-series"), {
      target: { value: text as string },
    });
    expect(screen.getByTestId("prop-chart-series-error")).toHaveTextContent(
      msgPattern as RegExp,
    );
  });

  it("resets the textarea when the slide id changes", () => {
    const { rerender } = render(
      <ChartEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />,
    );
    fireEvent.change(screen.getByTestId("prop-chart-series"), {
      target: { value: "garbage" },
    });
    expect(screen.getByTestId("prop-chart-series-error")).toBeInTheDocument();
    rerender(
      <ChartEditor
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        slide={{ ...baseSlide, id: "other" } as any}
        onChange={vi.fn()}
        deckId="d"
      />,
    );
    expect(screen.queryByTestId("prop-chart-series-error")).toBeNull();
  });
});
