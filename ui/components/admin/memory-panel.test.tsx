import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { MemoryPanel } from "./memory-panel";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MemoryConfig, MemoryRepoStatus, Memory } from "@/lib/types";

const makeWrapper = (opts?: {
  config?: Partial<MemoryConfig>;
  status?: Partial<MemoryRepoStatus>;
  memories?: Memory[];
}) => {
  const config: MemoryConfig = {
    enabled: false,
    owner: "",
    repo: "openzigs-memory",
    cacheTtlMs: 300000,
    ...opts?.config,
  };
  const status: MemoryRepoStatus = {
    connected: false,
    owner: "",
    repo: "openzigs-memory",
    memoryCount: 0,
    lastSynced: null,
    ...opts?.status,
  };
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  qc.setQueryData(["memory-config"], { config, status });
  if (opts?.memories) {
    qc.setQueryData(["memory-list"], { memories: opts.memories });
  }

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  Wrapper.displayName = "MemoryPanelTestWrapper";
  return Wrapper;
};

describe("MemoryPanel", () => {
  it("renders disabled state with enable button", () => {
    render(<MemoryPanel />, { wrapper: makeWrapper() });

    expect(screen.getByText("Agent Memory")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();
    expect(screen.getByText("Enable")).toBeInTheDocument();
  });

  it("shows setup prompt when enabled but not connected", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({ config: { enabled: true } }),
    });

    expect(screen.getByText("Repository Setup Required")).toBeInTheDocument();
    expect(screen.getByText("Create Memory Repository")).toBeInTheDocument();
  });

  it("shows error from status when setup fails", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true },
        status: { error: "Token missing or invalid" },
      }),
    });

    expect(screen.getByText("Token missing or invalid")).toBeInTheDocument();
  });

  it("shows memory list when enabled and connected", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true, owner: "testuser" },
        status: { connected: true, owner: "testuser", repo: "openzigs-memory", memoryCount: 1 },
        memories: [
          {
            id: "memories/conventions/esm.md",
            category: "conventions",
            title: "ESM imports",
            content: "Always use .js extensions",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            sha: "abc123",
          },
        ],
      }),
    });

    expect(screen.getByText("ESM imports")).toBeInTheDocument();
    expect(screen.getByText("Always use .js extensions")).toBeInTheDocument();
    expect(screen.getByText("conventions")).toBeInTheDocument();
  });

  it("shows empty state when no memories exist", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true, owner: "testuser" },
        status: { connected: true, owner: "testuser", memoryCount: 0 },
        memories: [],
      }),
    });

    expect(screen.getByText(/No memories yet/)).toBeInTheDocument();
  });

  it("shows create form when New Memory button is clicked", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true, owner: "testuser" },
        status: { connected: true, owner: "testuser", memoryCount: 0 },
        memories: [],
      }),
    });

    fireEvent.click(screen.getByText("New Memory"));

    expect(screen.getByText("Category")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Cancel")).toBeInTheDocument();
  });

  it("filters memories by category", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true, owner: "testuser" },
        status: { connected: true, owner: "testuser", memoryCount: 2 },
        memories: [
          {
            id: "memories/conventions/esm.md",
            category: "conventions",
            title: "ESM imports",
            content: "Use .js extensions",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            sha: "abc",
          },
          {
            id: "memories/patterns/singleton.md",
            category: "patterns",
            title: "Singleton pattern",
            content: "Use module-level instances",
            createdAt: "2025-01-01T00:00:00Z",
            updatedAt: "2025-01-01T00:00:00Z",
            sha: "def",
          },
        ],
      }),
    });

    // Both visible initially
    expect(screen.getByText("ESM imports")).toBeInTheDocument();
    expect(screen.getByText("Singleton pattern")).toBeInTheDocument();

    // Filter to conventions only
    fireEvent.click(screen.getByText("Conventions"));
    expect(screen.getByText("ESM imports")).toBeInTheDocument();
    expect(screen.queryByText("Singleton pattern")).not.toBeInTheDocument();
  });

  it("shows connected status with memory count", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true, owner: "testuser" },
        status: { connected: true, owner: "testuser", repo: "openzigs-memory", memoryCount: 5 },
        memories: [],
      }),
    });

    expect(screen.getByText(/Connected to testuser\/openzigs-memory · 5 memories/)).toBeInTheDocument();
  });

  it("shows Disable button when enabled", () => {
    render(<MemoryPanel />, {
      wrapper: makeWrapper({
        config: { enabled: true, owner: "testuser" },
        status: { connected: true, owner: "testuser", memoryCount: 0 },
        memories: [],
      }),
    });

    expect(screen.getByText("Disable")).toBeInTheDocument();
  });
});
