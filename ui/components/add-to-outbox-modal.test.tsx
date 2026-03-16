import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AddToOutboxModal } from "./add-to-outbox-modal";

vi.mock("@/lib/api", () => ({
  fetchJson: vi.fn((url: string) => {
    if (url.includes("connected-platforms")) {
      return Promise.resolve({
        platforms: [
          { platform: "twitter", connected: true },
          { platform: "pinterest", connected: true },
          { platform: "linkedin", connected: true },
          { platform: "facebook", connected: false },
          { platform: "reddit", connected: true },
          { platform: "youtube", connected: true },
          { platform: "instagram", connected: false },
        ],
      });
    }
    return Promise.resolve({ items: [], assets: [] });
  }),
}));

vi.mock("@/components/toast", () => ({
  showToast: vi.fn(),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

const noop = () => {};

describe("AddToOutboxModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <AddToOutboxModal open={false} onClose={noop} />,
      { wrapper },
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders modal heading when open", () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    expect(screen.getByRole("heading", { name: "Add to Publishing Queue" })).toBeInTheDocument();
  });

  it("renders all four source tabs", () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    expect(screen.getByRole("button", { name: "Text" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gallery" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "URL" })).toBeInTheDocument();
  });

  it("renders multi-platform selector with twitter selected by default", async () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    const twitterBtn = await waitFor(() => screen.getByRole("button", { name: "𝕏 / Twitter" }));
    expect(twitterBtn).toBeInTheDocument();
    // Twitter should be selected (has primary styling)
    expect(twitterBtn.className).toContain("border-primary");
  });

  it("toggles platform selection on click", async () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    const linkedinBtn = await waitFor(() => screen.getByRole("button", { name: "LinkedIn" }));
    // Initially unselected
    expect(linkedinBtn.className).not.toContain("bg-primary/10");

    fireEvent.click(linkedinBtn);
    expect(linkedinBtn.className).toContain("bg-primary/10");
  });

  it("does not allow deselecting the last platform", async () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    const twitterBtn = await waitFor(() => screen.getByRole("button", { name: "𝕏 / Twitter" }));
    // Try to deselect the only selected platform
    fireEvent.click(twitterBtn);
    // Should still be selected
    expect(twitterBtn.className).toContain("border-primary");
  });

  it("switching to URL tab shows AI Generate controls", () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "URL" }));
    expect(screen.getByText("AI Content Generation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI Generate" })).toBeInTheDocument();
  });

  it("URL tab shows image source options", () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "URL" }));
    expect(screen.getByText("Pull from site")).toBeInTheDocument();
  });

  it("AI Generate button is disabled without URL", () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "URL" }));
    const genBtn = screen.getByRole("button", { name: "AI Generate" });
    expect(genBtn).toBeDisabled();
  });

  it("AI Generate button becomes enabled when URL is filled", () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "URL" }));
    const urlInput = screen.getByPlaceholderText("https://example.com/content");
    fireEvent.change(urlInput, { target: { value: "https://example.com/article" } });
    const genBtn = screen.getByRole("button", { name: "AI Generate" });
    expect(genBtn).not.toBeDisabled();
  });

  it("shows multiple platform count in submit button", async () => {
    render(<AddToOutboxModal open={true} onClose={noop} />, { wrapper });
    // Wait for connected platforms to load, then select a second platform
    const linkedinBtn = await waitFor(() => screen.getByRole("button", { name: "LinkedIn" }));
    fireEvent.click(linkedinBtn);
    expect(screen.getByRole("button", { name: /Queue \(2 platforms\)/ })).toBeInTheDocument();
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<AddToOutboxModal open={true} onClose={onClose} />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("starts on gallery tab when initialAssetId is provided", () => {
    render(
      <AddToOutboxModal open={true} onClose={noop} initialAssetId="asset-1" initialAssetFilename="photo.jpg" />,
      { wrapper },
    );
    // Gallery tab should be active; check that gallery search input is visible
    expect(screen.getByPlaceholderText("Search by filename, prompt, or tags...")).toBeInTheDocument();
  });
});
