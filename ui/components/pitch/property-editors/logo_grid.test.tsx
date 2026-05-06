import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import LogoGridEditor from "./logo_grid";

const baseSlide = {
  template: "logo_grid" as const,
  content: {
    logos: [
      { alt: "A", imageUrl: "/a.png" },
      { alt: "B", imageUrl: "/b.png" },
      { alt: "C", imageUrl: "/c.png" },
      { alt: "D", imageUrl: "/d.png" },
    ],
  },
};

describe("LogoGridEditor", () => {
  it("renders heading, caption, grayscale toggle, and per-logo inputs", () => {
    render(<LogoGridEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-lg-heading")).toBeInTheDocument();
    expect(screen.getByTestId("prop-lg-caption")).toBeInTheDocument();
    expect(screen.getByTestId("prop-lg-grayscale")).toBeInTheDocument();
    expect(screen.getByTestId("prop-lg-logo-0-alt")).toBeInTheDocument();
    expect(screen.getByTestId("prop-lg-logo-3-image")).toBeInTheDocument();
  });

  it("editing alt fires onChange with the patched logo", () => {
    const onChange = vi.fn();
    render(<LogoGridEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-lg-logo-0-alt"), {
      target: { value: "Acme" },
    });
    expect(onChange.mock.calls[0][0].content.logos[0].alt).toBe("Acme");
  });

  it("toggling grayscale dispatches a boolean patch", () => {
    const onChange = vi.fn();
    render(<LogoGridEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-lg-grayscale"));
    expect(onChange.mock.calls[0][0].content.grayscale).toBe(true);
  });

  it("Remove disabled at 4 logos; Add appends a 5th", () => {
    const onChange = vi.fn();
    render(<LogoGridEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    expect(screen.getByTestId("prop-lg-logo-0-remove")).toBeDisabled();
    fireEvent.click(screen.getByTestId("prop-lg-add-logo"));
    expect(onChange.mock.calls[0][0].content.logos).toHaveLength(5);
  });
});
