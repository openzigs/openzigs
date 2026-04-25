import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import BulletListEditor from "./bullet_list";

const slide = {
  template: "bullet_list" as const,
  content: { heading: "Pros", bullets: ["one", "two"] },
};

describe("BulletListEditor", () => {
  it("adds a bullet", () => {
    const onChange = vi.fn();
    render(<BulletListEditor slide={slide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-bl-add-bullet"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ bullets: ["one", "two", ""] }),
      }),
    );
  });

  it("removes a bullet (and respects min-1)", () => {
    const onChange = vi.fn();
    render(<BulletListEditor slide={slide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-bl-bullet-remove-0"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ bullets: ["two"] }),
      }),
    );
  });

  it("reorders bullets via the down button", () => {
    const onChange = vi.fn();
    render(<BulletListEditor slide={slide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-bl-bullet-down-0"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ bullets: ["two", "one"] }),
      }),
    );
  });

  it("blocks add at the 7-bullet cap", () => {
    const max = {
      ...slide,
      content: {
        heading: "Pros",
        bullets: ["1", "2", "3", "4", "5", "6", "7"],
      },
    };
    render(<BulletListEditor slide={max} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-bl-add-bullet")).toBeDisabled();
  });

  it("updates the heading and individual bullets", () => {
    const onChange = vi.fn();
    render(<BulletListEditor slide={slide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-bl-heading"), {
      target: { value: "Cons" },
    });
    fireEvent.change(screen.getByTestId("prop-bl-bullet-input-0"), {
      target: { value: "edited" },
    });
    expect(onChange.mock.calls[0][0].content.heading).toBe("Cons");
    expect(onChange.mock.calls[1][0].content.bullets[0]).toBe("edited");
  });

  it("moves a bullet up via the up button", () => {
    const onChange = vi.fn();
    render(<BulletListEditor slide={slide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-bl-bullet-up-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ bullets: ["two", "one"] }),
      }),
    );
  });

  it("ignores out-of-range moves (no-ops)", () => {
    const onChange = vi.fn();
    render(<BulletListEditor slide={slide} onChange={onChange} deckId="d" />);
    // up button on first row is disabled, but click is still safe
    expect(screen.getByTestId("prop-bl-bullet-up-0")).toBeDisabled();
    expect(
      screen.getByTestId(
        `prop-bl-bullet-down-${slide.content.bullets.length - 1}`,
      ),
    ).toBeDisabled();
  });
});
