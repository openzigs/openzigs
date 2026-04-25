import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
  buildUrl: (p: string) => p,
}));
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    className?: string;
  }) => (
    <button type="button" onClick={() => onSelect?.()} className={className}>
      {children}
    </button>
  ),
}));

import { fetchJson } from "@/lib/api";
import PitchDeckListPage from "./page";

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const decksResponse = {
  decks: [
    {
      id: "d1",
      title: "Q1 Pitch",
      brand_kit_id: "kit-a",
      aspect_ratio: "16:9",
      slides: [{}, {}, {}],
      metadata: { tone: "formal" },
      created_at: "2026-04-25T00:00:00Z",
      updated_at: "2026-04-25T00:00:00Z",
    },
  ],
  pagination: { total: 1, limit: 50, offset: 0 },
};

const kitsResponse = {
  brandKits: [{ id: "kit-a", name: "Acme Light" }],
};

describe("PitchDeckListPage", () => {
  beforeEach(() => {
    pushMock.mockClear();
    vi.mocked(fetchJson).mockReset();
    vi.mocked(fetchJson).mockImplementation((path: string) => {
      if (path.includes("brand-kits")) return Promise.resolve(kitsResponse);
      if (path.includes("/api/admin/pitch/decks") && !path.includes("/decks/"))
        return Promise.resolve(decksResponse);
      return Promise.resolve({});
    });
  });

  it("renders the deck grid and shows the kit name", async () => {
    render(<PitchDeckListPage />, { wrapper });
    await waitFor(() => {
      expect(screen.getByTestId("deck-list-grid")).toBeInTheDocument();
    });
    expect(screen.getByTestId("deck-card-d1")).toBeInTheDocument();
    expect(screen.getByText("Q1 Pitch")).toBeInTheDocument();
    expect(screen.getByText("Acme Light")).toBeInTheDocument();
  });

  it("navigates to the editor when a card is clicked", async () => {
    render(<PitchDeckListPage />, { wrapper });
    await waitFor(() => screen.getByTestId("deck-card-d1"));
    fireEvent.click(screen.getByTestId("deck-card-d1"));
    expect(pushMock).toHaveBeenCalledWith("/pitch/d1");
  });

  it("shows the empty state when no decks exist", async () => {
    vi.mocked(fetchJson).mockImplementation((path: string) => {
      if (path.includes("brand-kits")) return Promise.resolve(kitsResponse);
      return Promise.resolve({
        decks: [],
        pagination: { total: 0, limit: 50, offset: 0 },
      });
    });
    render(<PitchDeckListPage />, { wrapper });
    await waitFor(() => {
      expect(screen.getByTestId("deck-list-empty")).toBeInTheDocument();
    });
  });

  it("requires confirmation before deleting and calls DELETE on confirm", async () => {
    render(<PitchDeckListPage />, { wrapper });
    await waitFor(() => screen.getByTestId("deck-card-d1"));
    fireEvent.click(screen.getByText("Delete"));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-label", expect.stringContaining("Q1 Pitch"));
    fireEvent.click(within(dialog).getByText("Delete"));
    await waitFor(() =>
      expect(vi.mocked(fetchJson)).toHaveBeenCalledWith(
        "/api/admin/pitch/decks/d1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
