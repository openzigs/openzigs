import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/api", () => ({
  buildUrl: (p: string) => p,
  fetchJson: vi.fn(),
}));

import { fetchJson } from "@/lib/api";
import { BrandKitPicker } from "./brand-kit-picker";

const KITS = [
  {
    id: "k1",
    name: "Default",
    primaryColor: "#111111",
    secondaryColor: "#222222",
    accentColor: "#333333",
    isStarter: true,
  },
  {
    id: "k2",
    name: "Custom",
    primaryColor: "#444444",
    secondaryColor: "#555555",
    accentColor: "#666666",
    isStarter: false,
  },
];

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeEach(() => {
  vi.mocked(fetchJson).mockReset();
  vi.mocked(fetchJson).mockResolvedValue({ brandKits: KITS });
});

describe("BrandKitPicker", () => {
  it("renders the kit list and active selection", async () => {
    render(
      <BrandKitPicker
        selectedId="k2"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(
        (screen.getByTestId("pitch-brand-kit-select") as HTMLSelectElement)
          .value,
      ).toBe("k2"),
    );
    expect(screen.getByTestId("pitch-brand-kit-picker")).toBeInTheDocument();
  });

  it("emits onSelect when a different kit is chosen", async () => {
    const onSelect = vi.fn();
    render(
      <BrandKitPicker
        selectedId="k1"
        onSelect={onSelect}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getByText(/Custom/)).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("pitch-brand-kit-select"), {
      target: { value: "k2" },
    });
    expect(onSelect).toHaveBeenCalledWith("k2");
  });

  it("invokes onEdit with the selected kit and onCreate with no args", async () => {
    const onEdit = vi.fn();
    const onCreate = vi.fn();
    render(
      <BrandKitPicker
        selectedId="k1"
        onSelect={vi.fn()}
        onEdit={onEdit}
        onCreate={onCreate}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getByText(/Default/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("pitch-brand-kit-edit"));
    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "k1" }),
    );
    fireEvent.click(screen.getByTestId("pitch-brand-kit-new"));
    expect(onCreate).toHaveBeenCalled();
  });
});

// Sub-issue #1048 - Apply / Copy buttons
describe("BrandKitPicker (#1048 Apply / Copy)", () => {
  beforeEach(() => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.spyOn(window, "prompt").mockReturnValue("New Kit");
  });

  it("does not render Apply or Copy buttons when handlers are not provided", async () => {
    render(
      <BrandKitPicker
        selectedId="k2"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByText(/Custom/)).toBeInTheDocument());
    expect(screen.queryByTestId("pitch-brand-kit-apply-to-deck")).toBeNull();
    expect(screen.queryByTestId("pitch-brand-kit-copy-from-deck")).toBeNull();
  });

  it("renders Apply button when onApplyToDeck is supplied; calls handler after confirm", async () => {
    const onApply = vi.fn();
    render(
      <BrandKitPicker
        selectedId="k2"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
        onApplyToDeck={onApply}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByText(/Custom/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pitch-brand-kit-apply-to-deck"));
    expect(window.confirm).toHaveBeenCalled();
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "k2" }));
  });

  it("Apply button is disabled when no kit is selected", async () => {
    render(
      <BrandKitPicker
        selectedId={null}
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
        onApplyToDeck={vi.fn()}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByText(/Default/)).toBeInTheDocument());
    expect(screen.getByTestId("pitch-brand-kit-apply-to-deck")).toBeDisabled();
  });

  it("renders Copy button when onCopyFromDeck is supplied; invokes handler", async () => {
    const onCopy = vi.fn();
    render(
      <BrandKitPicker
        selectedId="k1"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
        onCopyFromDeck={onCopy}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByText(/Default/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pitch-brand-kit-copy-from-deck"));
    expect(onCopy).toHaveBeenCalled();
  });

  it("does not invoke onApply when user cancels the confirm dialog", async () => {
    const onApply = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <BrandKitPicker
        selectedId="k2"
        onSelect={vi.fn()}
        onEdit={vi.fn()}
        onCreate={vi.fn()}
        onApplyToDeck={onApply}
      />,
      { wrapper },
    );
    await waitFor(() => expect(screen.getByText(/Custom/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pitch-brand-kit-apply-to-deck"));
    expect(onApply).not.toHaveBeenCalled();
  });
});
