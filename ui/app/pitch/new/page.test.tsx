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

  // ── AI script condensation (feat: 2 MB upload + condense flow) ──

  describe("AI script condensation", () => {
    /** Drive the wizard to the script step. */
    async function gotoScriptStep() {
      render(<NewPitchDeckPage />, { wrapper });
      await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
      fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
      fireEvent.click(screen.getByTestId("wizard-next"));
    }

    it("shows the condense panel when a > 50 KB file is dropped", async () => {
      await gotoScriptStep();
      const big = "X".repeat(200_000);
      const file = new File([big], "big.md", { type: "text/markdown" });
      const dropzone = screen.getByTestId("wizard-dropzone");
      fireEvent.drop(dropzone, {
        dataTransfer: { files: [file] },
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("wizard-condense-panel"),
        ).toBeInTheDocument(),
      );
      expect(screen.getByTestId("wizard-condense-filename")).toHaveTextContent(
        "big.md",
      );
      // 200 KB → "200.0 KB" displayed.
      expect(screen.getByTestId("wizard-condense-bytes")).toHaveTextContent(
        /200\.0 KB/,
      );
      // The textarea must NOT be auto-populated — explicit click required.
      expect(screen.getByTestId("wizard-script-textarea")).toHaveValue("");
    });

    it("posts to /script/condense and populates the textarea on confirm", async () => {
      // Override the default fetch mock for this test to return a
      // condensation envelope.
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          condensed: "tiny condensed summary",
          originalBytes: 200_000,
          condensedBytes: 22,
          chunks: 7,
        }),
      }) as unknown as typeof fetch;

      await gotoScriptStep();
      const big = "X".repeat(200_000);
      const file = new File([big], "spec.md", { type: "text/markdown" });
      fireEvent.drop(screen.getByTestId("wizard-dropzone"), {
        dataTransfer: { files: [file] },
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("wizard-condense-confirm"),
        ).toBeInTheDocument(),
      );

      fireEvent.click(screen.getByTestId("wizard-condense-confirm"));

      await waitFor(() =>
        expect(screen.getByTestId("wizard-script-textarea")).toHaveValue(
          "tiny condensed summary",
        ),
      );
      // Chip with original/condensed sizes.
      expect(screen.getByTestId("wizard-condense-chip")).toBeInTheDocument();
      // The condense panel disappears once the request succeeds.
      expect(screen.queryByTestId("wizard-condense-panel")).toBeNull();

      const fetchCalls = (
        global.fetch as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      const [url, init] = fetchCalls[0]!;
      expect(String(url)).toContain("/api/admin/pitch/script/condense");
      expect((init as RequestInit).method).toBe("POST");
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body).toEqual({ text: big });
    });

    it("rejects > 2 MB file with a toast and no fetch", async () => {
      const { showToast } = await import("@/components/toast");
      vi.mocked(showToast).mockClear();

      await gotoScriptStep();
      const oversize = "X".repeat(2_000_001);
      const file = new File([oversize], "huge.md", {
        type: "text/markdown",
      });
      fireEvent.drop(screen.getByTestId("wizard-dropzone"), {
        dataTransfer: { files: [file] },
      });
      await waitFor(() =>
        expect(vi.mocked(showToast)).toHaveBeenCalled(),
      );
      // No condense panel; no POST issued.
      expect(screen.queryByTestId("wizard-condense-panel")).toBeNull();
    });

    it("does NOT show the condense panel when a small file is dropped", async () => {
      await gotoScriptStep();
      const small = "small content";
      const file = new File([small], "small.md", { type: "text/markdown" });
      fireEvent.drop(screen.getByTestId("wizard-dropzone"), {
        dataTransfer: { files: [file] },
      });
      await waitFor(() =>
        expect(screen.getByTestId("wizard-script-textarea")).toHaveValue(
          small,
        ),
      );
      expect(screen.queryByTestId("wizard-condense-panel")).toBeNull();
    });
  });

  // ── AI model picker (fix: pitch-condense-model-picker) ──────────

  describe("AI model picker", () => {
    it("includes the chosen model in the condense AND draft request bodies", async () => {
      // Route fetchJson by URL: brand-kits → kitsResponse, /api/models →
      // a small models list so the InlineModelPicker has options.
      vi.mocked(fetchJson).mockImplementation(async (url: string) => {
        if (url.startsWith("/api/models")) {
          return {
            models: [
              { id: "gpt-4.1", name: "GPT-4.1" },
              { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
            ],
            selectedModel: "gpt-4.1",
          };
        }
        return kitsResponse;
      });

      // Two responses: one for /script/condense, one for /decks/draft.
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => "{}",
        json: async () => ({
          condensed: "tiny",
          originalBytes: 200_000,
          condensedBytes: 4,
          chunks: 1,
        }),
      });
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => "{}",
        json: async () => ({ deck: { id: "deck-model" } }),
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      // Navigate kit → script.
      render(<NewPitchDeckPage />, { wrapper });
      await waitFor(() => screen.getByTestId("wizard-kit-kit-a"));
      fireEvent.click(screen.getByTestId("wizard-kit-kit-a"));
      fireEvent.click(screen.getByTestId("wizard-next"));

      // Drop an oversize file to stage a condense request.
      const big = "Y".repeat(200_000);
      const file = new File([big], "spec.md", { type: "text/markdown" });
      fireEvent.drop(screen.getByTestId("wizard-dropzone"), {
        dataTransfer: { files: [file] },
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("wizard-condense-confirm"),
        ).toBeInTheDocument(),
      );

      // Advance to options to set the model BEFORE condensing — but the
      // picker only exists on step 3. Round-trip: go to options, pick
      // model, go back, condense, advance again, generate.
      // Simpler: the picker state persists across step changes since
      // it's hoisted on the page. Go to options first, pick model, then
      // back to script step to condense.
      fireEvent.change(screen.getByTestId("wizard-script-textarea"), {
        target: { value: "placeholder" },
      });
      fireEvent.click(screen.getByTestId("wizard-next"));
      // Wait for the model picker query to resolve and options to render.
      await waitFor(() =>
        expect(
          screen.getByTestId("wizard-model-picker-row"),
        ).toBeInTheDocument(),
      );
      const select = screen
        .getByTestId("wizard-model-picker-row")
        .querySelector("select");
      expect(select).not.toBeNull();
      await waitFor(() => {
        // Wait for the models list to populate the <select>.
        expect(select!.querySelectorAll("option").length).toBeGreaterThan(1);
      });
      fireEvent.change(select!, { target: { value: "claude-sonnet-4" } });

      // Back to script step → condense (now should include model).
      fireEvent.click(screen.getByTestId("wizard-back"));
      fireEvent.click(screen.getByTestId("wizard-condense-confirm"));
      await waitFor(() =>
        expect(screen.getByTestId("wizard-script-textarea")).toHaveValue(
          "tiny",
        ),
      );

      // Forward to options and submit draft.
      fireEvent.click(screen.getByTestId("wizard-next"));
      fireEvent.click(screen.getByTestId("wizard-generate"));
      await waitFor(() =>
        expect(pushMock).toHaveBeenCalledWith("/pitch/deck-model"),
      );

      const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
      const condenseCall = calls.find(([url]) =>
        String(url).includes("/script/condense"),
      );
      const draftCall = calls.find(([url]) =>
        String(url).includes("/decks/draft"),
      );
      expect(condenseCall).toBeDefined();
      expect(draftCall).toBeDefined();
      const condenseBody = JSON.parse(String(condenseCall![1].body));
      const draftBody = JSON.parse(String(draftCall![1].body));
      expect(condenseBody.model).toBe("claude-sonnet-4");
      expect(draftBody.options.model).toBe("claude-sonnet-4");
    });
  });
});
