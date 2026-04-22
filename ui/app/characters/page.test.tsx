/**
 * WS3-D (#933) — confirm-on-overwrite flow for the LoRA preset selector.
 *
 * Coverage:
 *  1. Switching presets while clean (dirty=false) applies immediately
 *     without showing the confirmation dialog.
 *  2. After the user manually edits a training field, switching presets
 *     opens the confirm dialog instead of clobbering the edits.
 *  3. Pressing "Keep my values" on the dialog leaves the field as edited.
 *  4. Pressing "Apply preset" on the dialog overwrites the edits.
 *  5. The "(modified)" indicator appears next to the preset dropdown when
 *     the form is dirty and disappears after a preset is applied.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Hoisted fixtures so the api mock factory can use them without a TDZ violation.
const { character, presets } = vi.hoisted(() => {
  const presets = {
    "sdxl-portrait": {
      label: "SDXL Portrait",
      description: "Balanced SDXL preset",
      baseModel: "sdxl" as const,
      rank: 16,
      loraAlpha: 32,
      learningRate: 0.0001,
      steps: 700,
      batchSize: 1,
      gradientAccumulationSteps: 1,
      mixedPrecision: "fp16" as const,
      resolution: 1024,
    },
    "flux-fast": {
      label: "Flux Fast",
      description: "Quick Flux preset",
      baseModel: "flux-schnell" as const,
      rank: 8,
      loraAlpha: 16,
      learningRate: 0.0005,
      steps: 300,
      batchSize: 2,
      gradientAccumulationSteps: 2,
      mixedPrecision: "bf16" as const,
      resolution: 512,
    },
  };
  const character = {
    id: "char-1",
    name: "Test Character",
    description: "A test character",
    triggerWord: "tstchar",
    referencePhotos: [
      "p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg", "p5.jpg",
    ],
    photoCaptions: {},
    trainedLoraPath: null,
    loraScale: 0.8,
    trainingConfig: null,
    status: "ready" as const,
    errorMessage: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return { character, presets };
});

vi.mock("@/components/toast", () => ({
  ToastContainer: () => null,
  showToast: vi.fn(),
}));

// Smart fetchJson mock: returns the same fixtures on refetch so React Query's
// invalidateQueries calls (fired by side-effect mutations on the page) don't
// clear our seeded cache.
vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn(async (url: string) => {
    if (url === "/api/characters") return { characters: [character] };
    if (url === "/api/admin/lora-presets") return { presets };
    return {};
  }),
  buildUrl: (p: string) => `http://localhost${p}`,
  buildMediaUrl: (p: string) => `http://localhost${p}`,
}));

import CharactersPage from "./page";

const PRESET_KEY = "sdxl-portrait";

const renderPage = () => {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  qc.setQueryData(["characters"], { characters: [character] });
  qc.setQueryData(["lora-presets"], { presets });

  return render(
    <QueryClientProvider client={qc}>
      <CharactersPage />
    </QueryClientProvider>,
  );
};

const selectCharacter = () => {
  fireEvent.click(screen.getByText("Test Character"));
};

const getRankSelect = (): HTMLSelectElement => {
  // The Rank <select> has no testid but is uniquely identifiable by the
  // "16 (default)" option label inside it.
  const opt = screen.getByRole("option", { name: "16 (default)" });
  return opt.closest("select") as HTMLSelectElement;
};

describe("CharactersPage — LoRA preset overwrite guard (#935)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies a preset without confirmation when the form is clean", () => {
    renderPage();
    selectCharacter();

    const presetSelect = screen.getByTestId("lora-preset-select") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: PRESET_KEY } });

    expect(presetSelect.value).toBe(PRESET_KEY);
    expect(
      screen.queryByText("Overwrite custom training parameters?"),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("lora-preset-modified")).not.toBeInTheDocument();
  });

  it("shows (modified) indicator after the user edits a training field", () => {
    renderPage();
    selectCharacter();

    const presetSelect = screen.getByTestId("lora-preset-select") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: PRESET_KEY } });
    expect(screen.queryByTestId("lora-preset-modified")).not.toBeInTheDocument();

    // Edit the LoRA Rank away from the preset's default (16 -> 32).
    fireEvent.change(getRankSelect(), { target: { value: "32" } });

    expect(screen.getByTestId("lora-preset-modified")).toHaveTextContent("(modified)");
  });

  it("opens confirm dialog when switching presets after manual edits", () => {
    renderPage();
    selectCharacter();

    const presetSelect = screen.getByTestId("lora-preset-select") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: PRESET_KEY } });
    fireEvent.change(getRankSelect(), { target: { value: "32" } });

    fireEvent.change(presetSelect, { target: { value: "flux-fast" } });

    expect(
      screen.getByText("Overwrite custom training parameters?"),
    ).toBeInTheDocument();
    expect(presetSelect.value).toBe(PRESET_KEY);
    expect(getRankSelect().value).toBe("32");
  });

  it("'Keep my values' cancels the preset switch and preserves edits", () => {
    renderPage();
    selectCharacter();

    const presetSelect = screen.getByTestId("lora-preset-select") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: PRESET_KEY } });
    fireEvent.change(getRankSelect(), { target: { value: "32" } });
    fireEvent.change(presetSelect, { target: { value: "flux-fast" } });

    fireEvent.click(screen.getByText("Keep my values"));

    expect(
      screen.queryByText("Overwrite custom training parameters?"),
    ).not.toBeInTheDocument();
    expect(presetSelect.value).toBe(PRESET_KEY);
    expect(getRankSelect().value).toBe("32");
    expect(screen.getByTestId("lora-preset-modified")).toBeInTheDocument();
  });

  it("'Apply preset' overwrites edits and clears the (modified) indicator", () => {
    renderPage();
    selectCharacter();

    const presetSelect = screen.getByTestId("lora-preset-select") as HTMLSelectElement;
    fireEvent.change(presetSelect, { target: { value: PRESET_KEY } });
    fireEvent.change(getRankSelect(), { target: { value: "32" } });
    fireEvent.change(presetSelect, { target: { value: "flux-fast" } });

    fireEvent.click(screen.getByText("Apply preset"));

    expect(
      screen.queryByText("Overwrite custom training parameters?"),
    ).not.toBeInTheDocument();
    expect(presetSelect.value).toBe("flux-fast");
    expect(getRankSelect().value).toBe("8");
    expect(screen.queryByTestId("lora-preset-modified")).not.toBeInTheDocument();
  });
});
