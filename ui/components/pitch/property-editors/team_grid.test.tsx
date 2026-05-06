import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TeamGridEditor from "./team_grid";

const baseSlide = {
  template: "team_grid" as const,
  content: {
    members: [
      { name: "Alice", role: "CEO" },
      { name: "Bob", role: "CTO" },
    ],
  },
};

describe("TeamGridEditor", () => {
  it("renders heading + a name+role+photo+bio per member", () => {
    render(<TeamGridEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-tg-heading")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tg-member-0-name")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tg-member-1-role")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tg-member-0-photo")).toBeInTheDocument();
    expect(screen.getByTestId("prop-tg-member-0-bio")).toBeInTheDocument();
  });

  it("editing a member name fires onChange with the patched member", () => {
    const onChange = vi.fn();
    render(<TeamGridEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-tg-member-0-name"), {
      target: { value: "Alicia" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({
          members: expect.arrayContaining([
            expect.objectContaining({ name: "Alicia" }),
          ]),
        }),
      }),
    );
  });

  it("Add member appends; Remove disabled when at minimum (2)", () => {
    const onChange = vi.fn();
    render(<TeamGridEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    expect(screen.getByTestId("prop-tg-member-0-remove")).toBeDisabled();
    fireEvent.click(screen.getByTestId("prop-tg-add-member"));
    expect(onChange.mock.calls[0][0].content.members).toHaveLength(3);
  });
});
