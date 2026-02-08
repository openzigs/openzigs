import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { EnvPanel } from "./env-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EnvEntry } from "@/lib/types";

const createWrapper = (data: EnvEntry[]) => {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Pre-fill cache
      },
    },
  });
  qc.setQueryData(["env"], data);

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "EnvPanelTestWrapper";
  return Wrapper;
};

describe("EnvPanel", () => {
  it("renders env items with configured status", () => {
    const data: EnvEntry[] = [
      { name: "BRAVE_API_KEY", label: "Brave API Key", configured: true },
      { name: "CHROME_DEBUG_HOST", label: "Chrome Debug Host", configured: false },
    ];

    render(<EnvPanel />, { wrapper: createWrapper(data) });

    expect(screen.getByText("Brave API Key")).toBeInTheDocument();
    expect(screen.getByText("Chrome Debug Host")).toBeInTheDocument();
  });

  it("shows empty message when no items", () => {
    render(<EnvPanel />, { wrapper: createWrapper([]) });

    expect(screen.getByText("No environment items.")).toBeInTheDocument();
  });
});
