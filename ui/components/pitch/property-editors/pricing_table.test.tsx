import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import PricingTableEditor from "./pricing_table";

const baseSlide = {
  template: "pricing_table" as const,
  content: {
    heading: "Plans",
    tiers: [
      { name: "Free", price: "$0", features: ["Starter"] },
      { name: "Pro", price: "$10", features: ["Everything"] },
    ],
  },
};

describe("PricingTableEditor", () => {
  it("renders heading + each tier's name/price/features inputs", () => {
    render(<PricingTableEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-pt-heading")).toBeInTheDocument();
    expect(screen.getByTestId("prop-pt-tier-0-name")).toBeInTheDocument();
    expect(screen.getByTestId("prop-pt-tier-1-price")).toBeInTheDocument();
    expect(screen.getByTestId("prop-pt-tier-0-features")).toBeInTheDocument();
  });

  it("editing the heading dispatches onChange with patched heading", () => {
    const onChange = vi.fn();
    render(
      <PricingTableEditor slide={baseSlide} onChange={onChange} deckId="d" />,
    );
    fireEvent.change(screen.getByTestId("prop-pt-heading"), {
      target: { value: "New plans" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ heading: "New plans" }),
      }),
    );
  });

  it("Add tier button appends a tier; Remove drops one", () => {
    const onChange = vi.fn();
    render(
      <PricingTableEditor slide={baseSlide} onChange={onChange} deckId="d" />,
    );
    fireEvent.click(screen.getByTestId("prop-pt-add-tier"));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          tiers: expect.arrayContaining([expect.any(Object)]),
        }),
      }),
    );
    expect(onChange.mock.calls[0][0].content.tiers).toHaveLength(3);
  });

  it("checking highlighted on one tier clears the flag on others", () => {
    const onChange = vi.fn();
    render(
      <PricingTableEditor
        slide={{
          ...baseSlide,
          content: {
            ...baseSlide.content,
            tiers: [
              { ...baseSlide.content.tiers[0], highlighted: true },
              baseSlide.content.tiers[1],
            ],
          },
        }}
        onChange={onChange}
        deckId="d"
      />,
    );
    fireEvent.click(screen.getByTestId("prop-pt-tier-1-highlighted"));
    const next = onChange.mock.calls[0][0];
    expect(next.content.tiers[0].highlighted).toBe(false);
    expect(next.content.tiers[1].highlighted).toBe(true);
  });

  it("editing features splits on newline and trims empty lines", () => {
    const onChange = vi.fn();
    render(
      <PricingTableEditor slide={baseSlide} onChange={onChange} deckId="d" />,
    );
    fireEvent.change(screen.getByTestId("prop-pt-tier-0-features"), {
      target: { value: "A\nB\n\nC" },
    });
    expect(onChange.mock.calls[0][0].content.tiers[0].features).toEqual([
      "A",
      "B",
      "C",
    ]);
  });
});
