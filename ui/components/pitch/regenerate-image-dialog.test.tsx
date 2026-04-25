import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("@/lib/api", () => ({
  buildUrl: (p: string) => p,
  fetchJson: vi.fn(),
}));

// Inline-mount Dialog so jsdom can find its children without portals.
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: ReactNode;
  }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children, ...rest }: { children: ReactNode }) => (
    <div {...rest}>{children}</div>
  ),
  DialogHeader: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
}));

import { fetchJson } from "@/lib/api";
import { RegenerateImageDialog } from "./regenerate-image-dialog";

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe("RegenerateImageDialog", () => {
  beforeEach(() => {
    vi.mocked(fetchJson).mockReset();
  });

  it("does not render when closed", () => {
    render(
      <RegenerateImageDialog
        open={false}
        onOpenChange={vi.fn()}
        deckId="d"
        slideId="s"
        initialPrompt="hi"
        mode="background"
      />,
      { wrapper },
    );
    expect(screen.queryByTestId("pitch-regen-image-dialog")).toBeNull();
  });

  it("renders the prompt and submit when open", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ characters: [] });
    render(
      <RegenerateImageDialog
        open
        onOpenChange={vi.fn()}
        deckId="d"
        slideId="s"
        initialPrompt="a sunny field"
        mode="background"
      />,
      { wrapper },
    );
    expect(
      (screen.getByTestId("pitch-regen-image-prompt") as HTMLTextAreaElement)
        .value,
    ).toBe("a sunny field");
    expect(screen.getByTestId("pitch-regen-image-submit")).toBeInTheDocument();
  });

  it("disables submit while the prompt is too short", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ characters: [] });
    render(
      <RegenerateImageDialog
        open
        onOpenChange={vi.fn()}
        deckId="d"
        slideId="s"
        initialPrompt="hi"
        mode="background"
      />,
      { wrapper },
    );
    const submit = screen.getByTestId(
      "pitch-regen-image-submit",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("filters characters to status=ready and posts loraTriggerWord when toggled", async () => {
    vi.mocked(fetchJson).mockImplementation(async (url: string) => {
      if (url.endsWith("/api/characters")) {
        return {
          characters: [
            { id: "c1", name: "Ready One", status: "ready", triggerWord: "rdy" },
            { id: "c2", name: "Pending", status: "training" },
          ],
        };
      }
      return { jobId: "j1", assetId: "a1" };
    });
    const onClose = vi.fn();
    const onQueued = vi.fn();
    render(
      <RegenerateImageDialog
        open
        onOpenChange={onClose}
        deckId="d"
        slideId="s"
        initialPrompt="a long enough prompt"
        mode="inline"
        onQueued={onQueued}
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-regen-image-lora-toggle"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("pitch-regen-image-lora-toggle"));
    fireEvent.change(screen.getByTestId("pitch-regen-image-lora-select"), {
      target: { value: "c1" },
    });
    fireEvent.click(screen.getByTestId("pitch-regen-image-submit"));
    await waitFor(() => expect(onQueued).toHaveBeenCalledWith("j1", "a1"));
    const submitCall = vi
      .mocked(fetchJson)
      .mock.calls.find(([url]) =>
        String(url).includes("/slides/s/image"),
      );
    expect(submitCall).toBeTruthy();
    const body = JSON.parse(
      (submitCall![1] as { body: string }).body,
    );
    expect(body).toMatchObject({
      mode: "inline",
      loraTriggerWord: "rdy",
    });
    expect(body).not.toHaveProperty("loraId");
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it("surfaces fetch errors inline", async () => {
    vi.mocked(fetchJson).mockImplementation(async (url: string) => {
      if (url.endsWith("/api/characters")) return { characters: [] };
      throw new Error("backend exploded");
    });
    render(
      <RegenerateImageDialog
        open
        onOpenChange={vi.fn()}
        deckId="d"
        slideId="s"
        initialPrompt="long enough prompt here"
        mode="background"
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByTestId("pitch-regen-image-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("pitch-regen-image-error")).toHaveTextContent(
        /backend exploded/,
      ),
    );
  });

  it("closes via the Cancel button", () => {
    vi.mocked(fetchJson).mockResolvedValue({ characters: [] });
    const onOpenChange = vi.fn();
    render(
      <RegenerateImageDialog
        open
        onOpenChange={onOpenChange}
        deckId="d"
        slideId="s"
        initialPrompt="hi there friend"
        mode="background"
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables submit when LoRA is on but no character with trigger word is selected", async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      characters: [
        { id: "c1", name: "No Trigger", status: "ready" },
      ],
    });
    render(
      <RegenerateImageDialog
        open
        onOpenChange={vi.fn()}
        deckId="d"
        slideId="s"
        initialPrompt="long enough prompt"
        mode="background"
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("pitch-regen-image-lora-toggle"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("pitch-regen-image-lora-toggle"));
    fireEvent.change(screen.getByTestId("pitch-regen-image-lora-select"), {
      target: { value: "c1" },
    });
    expect(
      (screen.getByTestId("pitch-regen-image-submit") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("updates the prompt when typed into", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ characters: [] });
    render(
      <RegenerateImageDialog
        open
        onOpenChange={vi.fn()}
        deckId="d"
        slideId="s"
        initialPrompt="hi"
        mode="background"
      />,
      { wrapper },
    );
    const ta = screen.getByTestId(
      "pitch-regen-image-prompt",
    ) as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "a brand new prompt" } });
    expect(ta.value).toBe("a brand new prompt");
  });
});
