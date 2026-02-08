import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SectionCard } from "./section-card";

describe("SectionCard", () => {
  it("renders title and children", () => {
    render(
      <SectionCard title="Test Section">
        <p>Hello world</p>
      </SectionCard>
    );

    expect(screen.getByText("Test Section")).toBeInTheDocument();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders as a section element", () => {
    const { container } = render(
      <SectionCard title="S">
        <span>content</span>
      </SectionCard>
    );

    expect(container.querySelector("section")).toBeTruthy();
  });
});
