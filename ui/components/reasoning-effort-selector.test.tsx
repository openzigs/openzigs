import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  ReasoningEffortSelector,
  ProviderBadge,
  supportsReasoning,
} from "./reasoning-effort-selector";

describe("supportsReasoning", () => {
  it("returns true for known reasoning models", () => {
    expect(supportsReasoning("o1")).toBe(true);
    expect(supportsReasoning("o1-mini")).toBe(true);
    expect(supportsReasoning("o3")).toBe(true);
    expect(supportsReasoning("o3-mini")).toBe(true);
    expect(supportsReasoning("o4-mini")).toBe(true);
  });

  it("returns true for models starting with o1/o3/o4", () => {
    expect(supportsReasoning("o1-preview")).toBe(true);
    expect(supportsReasoning("o3-custom")).toBe(true);
    expect(supportsReasoning("o4-pro")).toBe(true);
  });

  it("returns false for non-reasoning models", () => {
    expect(supportsReasoning("gpt-4o")).toBe(false);
    expect(supportsReasoning("claude-3.5-sonnet")).toBe(false);
    expect(supportsReasoning("llama-3")).toBe(false);
  });
});

describe("ReasoningEffortSelector", () => {
  it("renders nothing for non-reasoning models", () => {
    const { container } = render(
      <ReasoningEffortSelector
        value="medium"
        onChange={vi.fn()}
        modelId="gpt-4o"
      />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders for reasoning models", () => {
    render(
      <ReasoningEffortSelector
        value="medium"
        onChange={vi.fn()}
        modelId="o3-mini"
      />
    );
    expect(screen.getByText("Reasoning:")).toBeInTheDocument();
  });

  it("shows the radiogroup", () => {
    render(
      <ReasoningEffortSelector
        value="high"
        onChange={vi.fn()}
        modelId="o1"
      />
    );
    expect(screen.getByRole("radiogroup", { name: /reasoning effort/i })).toBeInTheDocument();
  });

  it("calls onChange when a different level is clicked", () => {
    const onChange = vi.fn();
    render(
      <ReasoningEffortSelector
        value="medium"
        onChange={onChange}
        modelId="o1"
      />
    );
    const lowRadio = screen.getByRole("radio", { name: /low/i });
    fireEvent.click(lowRadio);
    expect(onChange).toHaveBeenCalledWith("low");
  });

  it("marks the current value as checked", () => {
    render(
      <ReasoningEffortSelector
        value="high"
        onChange={vi.fn()}
        modelId="o1"
      />
    );
    expect(screen.getByRole("radio", { name: /^high$/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /^low$/i })).toHaveAttribute("aria-checked", "false");
  });
});

describe("ProviderBadge", () => {
  it("renders nothing for null provider", () => {
    const { container } = render(<ProviderBadge provider={null} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing for copilot provider", () => {
    const { container } = render(
      <ProviderBadge provider={{ type: "copilot", label: "GitHub Copilot" }} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders badge for non-copilot providers", () => {
    render(
      <ProviderBadge provider={{ type: "openai", label: "OpenAI Direct" }} />
    );
    expect(screen.getByText("OpenAI Direct")).toBeInTheDocument();
  });
});
