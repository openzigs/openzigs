import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
}));
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(),
  buildUrl: (p: string) => p,
}));
vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

import { fetchJson } from "@/lib/api";
import NewPitchDeckPage from "./page";

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const kitsResponse = {
  brandKits: [
    { id: "kit-a", name: "Acme Light" },
    { id: "kit-b", name: "Acme Dark" },
  ],
};

describe("NewPitchDeckPage wizard", () => {
  beforeEach(() => {
    pushMock.mockClear();
    vi.mocked(fetchJson).mockReset();
    vi.mocked(fetchJson).mockResolvedValue(kitsResponse);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => "{}",
      json: async () => ({ deck: { id: "new-deck-1" } }),
    }) as unknown as typeof fetch;
  });

  it("starts on the kit step and lists kits", async () => {
    render(<NewPitchDeckPage />, { wrapper });
    expect(screen.getByTestId("wizard-step-kit")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("wizard-kit-kit-a")).toBeInTheDocument(),
    );
  });

  it("disables Next until a kit is selected, then advances", async () => {
    render(<NewPitchDeckPage />, { wrapper });
    await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
    expect(screen.getByTestId("wizard-next")).toBeDisabled();
    fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
    expect(screen.getByTestId("wizard-next")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("wizard-step-script")).toBeInTheDocument();
  });

  it("advances through script step after typing", async () => {
    render(<NewPitchDeckPage />, { wrapper });
    await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.change(screen.getByTestId("wizard-script-textarea"), {
      target: { value: "This is the pitch script." },
    });
    expect(screen.getByTestId("wizard-script-bytes")).toHaveTextContent(/bytes/);
    fireEvent.click(screen.getByTestId("wizard-next"));
    expect(screen.getByTestId("wizard-step-options")).toBeInTheDocument();
  });

  it("submits via POST and navigates to the new deck on success", async () => {
    render(<NewPitchDeckPage />, { wrapper });
    await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.change(screen.getByTestId("wizard-script-textarea"), {
      target: { value: "Pitch script body." },
    });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-slide-count-15"));
    fireEvent.click(screen.getByTestId("wizard-tone-casual"));
    fireEvent.change(screen.getByTestId("wizard-audience"), {
      target: { value: "CTOs" },
    });
    fireEvent.click(screen.getByTestId("wizard-generate"));

    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/pitch/new-deck-1"),
    );
    const fetchCalls = (global.fetch as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(fetchCalls.length).toBeGreaterThan(0);
    const [url, init] = fetchCalls[0]!;
    expect(String(url)).toContain("/api/admin/pitch/decks/draft");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      brandKitId: "kit-a",
      script: "Pitch script body.",
      options: { targetSlideCount: 15, audience: "CTOs", tone: "casual" },
    });
    // Guard against regression: the backend `DraftDeckBody` schema is
    // `.strict()` and rejects `slideCount`. If anyone re-introduces it,
    // this assertion fails immediately.
    expect(body.options).not.toHaveProperty("slideCount");
  });

  it("can go back to a previous step", async () => {
    render(<NewPitchDeckPage />, { wrapper });
    await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-back"));
    expect(screen.getByTestId("wizard-step-kit")).toBeInTheDocument();
  });

  it("renders all 5 canonical backend tone options (drift guard)", async () => {
    // These values MUST match `DeckToneEnum` in
    // `src/pitch/pitch-schema.ts`. The backend POST /draft validator is
    // `.strict()` and 400s on values outside the enum. If you change
    // this list, also update `DeckToneEnum` and the contract test in
    // `src/pitch/pitch-schema.test.ts`.
    const canonicalTones = [
      "formal",
      "casual",
      "technical",
      "sales",
      "educational",
    ] as const;
    render(<NewPitchDeckPage />, { wrapper });
    await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.change(screen.getByTestId("wizard-script-textarea"), {
      target: { value: "x" },
    });
    fireEvent.click(screen.getByTestId("wizard-next"));
    for (const t of canonicalTones) {
      expect(screen.getByTestId(`wizard-tone-${t}`)).toBeInTheDocument();
    }
    // Regression: the legacy "persuasive" value MUST NOT exist as its own
    // option (it 400s against the backend enum).
    expect(screen.queryByTestId("wizard-tone-persuasive")).toBeNull();
  });

  it("submits the selected tone (sales) in the POST body", async () => {
    render(<NewPitchDeckPage />, { wrapper });
    await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.change(screen.getByTestId("wizard-script-textarea"), {
      target: { value: "Pitch script body." },
    });
    fireEvent.click(screen.getByTestId("wizard-next"));
    fireEvent.click(screen.getByTestId("wizard-tone-sales"));
    fireEvent.click(screen.getByTestId("wizard-generate"));
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/pitch/new-deck-1"),
    );
    const fetchCalls = (
      global.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls;
    const [, init] = fetchCalls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.options.tone).toBe("sales");
  });
});
