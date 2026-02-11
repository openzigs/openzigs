import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { PersonalityPanel } from "./personality-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PersonalityConfig } from "@/lib/types";

const baseConfig: PersonalityConfig = {
  systemInstruction: "You are a test bot.",
  prePrompt: "Be concise.",
  postPrompt: "Sign off.",
  enabled: true,
  updatedAt: "2025-01-01T00:00:00Z",
  mode: "append",
};

const createWrapper = (data: PersonalityConfig) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["personality"], data);

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "PersonalityTestWrapper";
  return Wrapper;
};

describe("PersonalityPanel", () => {
  it("renders personality form fields", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.getByText("Personality Injection")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("You are a helpful AI assistant…")).toHaveValue("You are a test bot.");
    expect(screen.getByPlaceholderText(/Instructions injected before/)).toHaveValue("Be concise.");
    expect(screen.getByPlaceholderText(/Instructions injected after/)).toHaveValue("Sign off.");
  });

  it("renders mode selector with append and replace options", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.getByText("System Prompt Mode")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /append/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /replace/i })).toBeInTheDocument();
  });

  it("shows append as selected by default", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper(baseConfig) });

    const appendRadio = screen.getByRole("radio", { name: /append/i });
    expect(appendRadio).toHaveAttribute("aria-checked", "true");
  });

  it("shows replace mode warning when replace is selected", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper({ ...baseConfig, mode: "replace" }) });

    expect(screen.getByText(/Replace mode removes all SDK safety guardrails/)).toBeInTheDocument();
  });

  it("does not show replace warning in append mode", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.queryByText(/Replace mode removes all SDK safety guardrails/)).not.toBeInTheDocument();
  });

  it("shows (recommended) label on append option", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.getByText(/append \(recommended\)/i)).toBeInTheDocument();
  });

  it("shows preview with SDK guardrails header in append mode", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper(baseConfig) });

    // Open preview
    fireEvent.click(screen.getByText("Show Prompt Preview"));

    expect(screen.getByText(/How a message/)).toBeInTheDocument();
    expect(screen.getByText(/SDK Default Guardrails/)).toBeInTheDocument();
  });

  it("shows preview with replace warning in replace mode", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper({ ...baseConfig, mode: "replace" }) });

    fireEvent.click(screen.getByText("Show Prompt Preview"));

    expect(screen.getByText(/No SDK guardrails applied/)).toBeInTheDocument();
  });

  it("disables mode selector when personality is disabled", () => {
    render(<PersonalityPanel />, { wrapper: createWrapper({ ...baseConfig, enabled: false }) });

    const radios = screen.getAllByRole("radio");
    radios.forEach((radio) => {
      expect(radio).toBeDisabled();
    });
  });
});
