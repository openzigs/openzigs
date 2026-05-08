import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import AgendaEditor from "./agenda";

const autoSlide = {
  template: "agenda" as const,
  content: { mode: "auto" as const },
};

const manualSlide = {
  template: "agenda" as const,
  content: { mode: "manual" as const, items: ["Intro", "Demo"] },
};

describe("AgendaEditor", () => {
  it("renders heading + auto toggle + auto-mode note when mode=auto", () => {
    render(<AgendaEditor slide={autoSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-ag-heading")).toBeInTheDocument();
    expect(screen.getByTestId("prop-ag-auto")).toBeChecked();
    expect(screen.getByTestId("prop-ag-auto-note")).toBeInTheDocument();
    // Item list is hidden in auto mode.
    expect(screen.queryByTestId("prop-ag-add-item")).toBeNull();
  });

  it("toggling auto off switches mode to manual", () => {
    const onChange = vi.fn();
    render(<AgendaEditor slide={autoSlide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-ag-auto"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ mode: "manual" }),
      }),
    );
  });

  it("renders the manual item list when mode=manual; editing dispatches onChange", () => {
    const onChange = vi.fn();
    render(<AgendaEditor slide={manualSlide} onChange={onChange} deckId="d" />);
    expect(screen.getByTestId("prop-ag-item-0")).toBeInTheDocument();
    expect(screen.getByTestId("prop-ag-add-item")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("prop-ag-item-0"), {
      target: { value: "Welcome" },
    });
    expect(onChange.mock.calls[0][0].content.items[0]).toBe("Welcome");
  });

  it("Add item appends a new entry; numbered toggle dispatches a boolean", () => {
    const onChange = vi.fn();
    render(<AgendaEditor slide={manualSlide} onChange={onChange} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-ag-add-item"));
    expect(onChange.mock.calls[0][0].content.items).toHaveLength(3);
    fireEvent.click(screen.getByTestId("prop-ag-numbered"));
    expect(onChange.mock.calls[1][0].content.numbered).toBe(true);
  });
});
