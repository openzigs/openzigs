import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TwoColumnEditor from "./two_column";

const baseSlide = {
  template: "two_column" as const,
  content: {
    heading: "Compare",
    left: "Left col",
    right: "Right col",
  },
};

describe("TwoColumnEditor", () => {
  it("renders heading, left, and right column inputs", () => {
    render(
      <TwoColumnEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />,
    );
    expect(screen.getByTestId("prop-tc-heading")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tc-left")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tc-right")).toBeInTheDocument();
  });

  it("renders left + right inline image prompt + alt + Regenerate controls (Issue: pitch image quality 2026-05)", () => {
    render(
      <TwoColumnEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />,
    );
    // Left slot
    expect(screen.getByTestId("prop-tc-left-img-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tc-left-img-alt")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tc-left-img-regen")).toBeInTheDocument();
    // Right slot
    expect(screen.getByTestId("prop-tc-right-img-prompt")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tc-right-img-alt")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tc-right-img-regen")).toBeInTheDocument();
  });

  it("disables the Regenerate button when no prompt has been authored yet", () => {
    render(
      <TwoColumnEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />,
    );
    expect(screen.getByTestId("prop-tc-left-img-regen")).toBeDisabled();
    expect(screen.getByTestId("prop-tc-right-img-regen")).toBeDisabled();
  });

  it("editing the left image prompt fires onChange with the patched left_image", () => {
    const onChange = vi.fn();
    render(
      <TwoColumnEditor slide={baseSlide} onChange={onChange} deckId="d" />,
    );
    fireEvent.change(screen.getByTestId("prop-tc-left-img-prompt"), {
      target: { value: "a sunny beach" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          left_image: expect.objectContaining({ prompt: "a sunny beach" }),
        }),
      }),
    );
  });

  it("editing the right image alt fires onChange with the patched right_image", () => {
    const onChange = vi.fn();
    render(
      <TwoColumnEditor slide={baseSlide} onChange={onChange} deckId="d" />,
    );
    fireEvent.change(screen.getByTestId("prop-tc-right-img-alt"), {
      target: { value: "city skyline" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          right_image: expect.objectContaining({ alt: "city skyline" }),
        }),
      }),
    );
  });
});
