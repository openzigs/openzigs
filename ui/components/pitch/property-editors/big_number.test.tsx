import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import BigNumberEditor from "./big_number";

const baseSlide = {
  template: "big_number" as const,
  content: { value: "42%", label: "Conversion" },
};

describe("BigNumberEditor", () => {
  it("renders value, label, support, trend, and trend-label inputs", () => {
    render(<BigNumberEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-bn-value")).toBeInTheDocument();
    expect(screen.getByTestId("prop-bn-label")).toBeInTheDocument();
    expect(screen.getByTestId("prop-bn-support")).toBeInTheDocument();
    expect(screen.getByTestId("prop-bn-trend")).toBeInTheDocument();
    expect(screen.getByTestId("prop-bn-trend-label")).toBeInTheDocument();
  });

  it("editing the value fires onChange with the patched value", () => {
    const onChange = vi.fn();
    render(<BigNumberEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-bn-value"), {
      target: { value: "99" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ value: "99" }),
      }),
    );
  });

  it("selecting a trend dispatches the enum value; empty resets to undefined", () => {
    const onChange = vi.fn();
    render(<BigNumberEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-bn-trend"), {
      target: { value: "up" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ trend: "up" }),
      }),
    );
    fireEvent.change(screen.getByTestId("prop-bn-trend"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ trend: undefined }),
      }),
    );
  });
});
