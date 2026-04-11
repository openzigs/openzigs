import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ModelConfigPanel } from "./model-config-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ModelConfig } from "@/lib/types";

const baseConfig: ModelConfig = {
  reasoningEffort: "medium",
  provider: null,
  workingDirectory: null,
};

const configWithProvider: ModelConfig = {
  reasoningEffort: "high",
  provider: {
    type: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test-xxxx",
  },
  workingDirectory: null,
};

const createWrapper = (data: ModelConfig) => {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["models-config"], data);

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "ModelConfigTestWrapper";
  return Wrapper;
};

describe("ModelConfigPanel", () => {
  it("renders reasoning effort selector", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.getByText("Default Reasoning Effort")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Low/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Medium/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^High$/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /^xHigh$/i })).toBeInTheDocument();
  });

  it("selects the configured reasoning effort level", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(baseConfig) });

    const mediumRadio = screen.getByRole("radio", { name: /Medium/i });
    expect(mediumRadio).toHaveAttribute("aria-checked", "true");
  });

  it("renders provider toggle switch", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.getByText("Provider Configuration")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: /BYOK Provider/i })).toBeInTheDocument();
  });

  it("does not show provider fields when BYOK is disabled", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.queryByText("Provider Type")).not.toBeInTheDocument();
    expect(screen.queryByText("Base URL")).not.toBeInTheDocument();
  });

  it("shows provider fields when BYOK is enabled", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(configWithProvider) });

    expect(screen.getByText("Provider Type")).toBeInTheDocument();
    // Scope to the Provider Type radiogroup to avoid collision with AI Source radios
    const providerGroup = screen.getByRole("radiogroup", { name: /Provider Type/i });
    expect(within(providerGroup).getByRole("radio", { name: /OpenAI/i })).toBeInTheDocument();
    expect(within(providerGroup).getByRole("radio", { name: /Azure/i })).toBeInTheDocument();
    expect(within(providerGroup).getByRole("radio", { name: /Anthropic/i })).toBeInTheDocument();
    expect(within(providerGroup).getByRole("radio", { name: /Ollama/i })).toBeInTheDocument();
    expect(within(providerGroup).getByRole("radio", { name: /Custom/i })).toBeInTheDocument();
  });

  it("toggles BYOK provider on click", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(baseConfig) });

    const toggle = screen.getByRole("switch", { name: /BYOK Provider/i });
    fireEvent.click(toggle);

    expect(screen.getByText("Provider Type")).toBeInTheDocument();
  });

  it("shows API key field for non-ollama providers", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(configWithProvider) });

    expect(screen.getByText("API Key")).toBeInTheDocument();
  });

  it("shows azure API version field when azure is selected", () => {
    render(<ModelConfigPanel />, {
      wrapper: createWrapper({
        ...baseConfig,
        provider: {
          type: "azure",
          baseUrl: "https://my-resource.openai.azure.com/",
          azure: { apiVersion: "2024-10-21" },
        },
      }),
    });

    expect(screen.getByText("Azure API Version")).toBeInTheDocument();
  });

  it("shows test connection button when provider is enabled", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(configWithProvider) });

    expect(screen.getByText("Test Connection")).toBeInTheDocument();
  });

  it("shows clear provider button when provider exists", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(configWithProvider) });

    expect(screen.getByText("Clear Provider")).toBeInTheDocument();
  });

  it("masks API key by default", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(configWithProvider) });

    const apiKeyInput = screen.getByPlaceholderText(/already set/);
    expect(apiKeyInput).toHaveAttribute("type", "password");
  });

  it("toggles API key visibility", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(configWithProvider) });

    const toggleBtn = screen.getByLabelText("Show API key");
    fireEvent.click(toggleBtn);

    const apiKeyInput = screen.getByPlaceholderText(/already set/);
    expect(apiKeyInput).toHaveAttribute("type", "text");
  });

  it("shows save button", () => {
    render(<ModelConfigPanel />, { wrapper: createWrapper(baseConfig) });

    expect(screen.getByText("Save Configuration")).toBeInTheDocument();
  });
});
