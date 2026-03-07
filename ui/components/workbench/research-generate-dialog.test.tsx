import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResearchGenerateDialog } from "./research-generate-dialog";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/* ── Mock socket-context ─────────────────────────────── */

const mockSocket = {
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};

vi.mock("@/lib/socket-context", () => ({
  useSocket: () => ({ socket: mockSocket, connected: true }),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
};

describe("ResearchGenerateDialog", () => {
  beforeEach(() => {
    mockSocket.emit.mockClear();
  });

  it("renders dialog title when open", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );
    expect(screen.getByText("Research & Generate")).toBeInTheDocument();
  });

  it("does not render content when closed", () => {
    render(
      <ResearchGenerateDialog open={false} onOpenChange={() => {}} />,
      { wrapper },
    );
    expect(screen.queryByText("Research & Generate")).not.toBeInTheDocument();
  });

  it("renders all form fields", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );
    expect(screen.getByLabelText(/topic/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/slant/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/web articles/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/youtube videos/i)).toBeInTheDocument();
    expect(screen.getByText("Generate Images")).toBeInTheDocument();
    expect(screen.getByText("Generate Video")).toBeInTheDocument();
  });

  it("disables Generate button when topic is empty", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );
    const generateBtn = screen.getByRole("button", { name: /generate/i });
    expect(generateBtn).toBeDisabled();
  });

  it("enables Generate button when topic is filled", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );
    const topicInput = screen.getByLabelText(/topic/i);
    fireEvent.change(topicInput, { target: { value: "AI Coding Tools" } });
    const generateBtn = screen.getByRole("button", { name: /generate/i });
    expect(generateBtn).not.toBeDisabled();
  });

  it("emits chat:message on submit with correct content", () => {
    const onOpenChange = vi.fn();
    render(
      <ResearchGenerateDialog open={true} onOpenChange={onOpenChange} />,
      { wrapper },
    );

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "Best LLMs 2026" } });
    fireEvent.change(screen.getByLabelText(/slant/i), { target: { value: "developer productivity" } });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    expect(mockSocket.emit).toHaveBeenCalledWith("chat:message", expect.objectContaining({
      content: expect.stringContaining("[Using Research Synthesizer skill]"),
    }));
    expect(mockSocket.emit).toHaveBeenCalledWith("chat:message", expect.objectContaining({
      content: expect.stringContaining("Best LLMs 2026"),
    }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("includes slant in the prompt when provided", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "Cloud Hosting" } });
    fireEvent.change(screen.getByLabelText(/slant/i), { target: { value: "cost comparison" } });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    const emitCall = mockSocket.emit.mock.calls[0];
    expect(emitCall[1].content).toContain("cost comparison");
  });

  it("includes media generation flags in the prompt", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );

    fireEvent.change(screen.getByLabelText(/topic/i), { target: { value: "Test" } });

    const imageCheckbox = screen.getByText("Generate Images").closest("label")!.querySelector("input")!;
    fireEvent.click(imageCheckbox);

    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    const emitCall = mockSocket.emit.mock.calls[0];
    expect(emitCall[1].content).toContain("Generate original supporting images");
  });

  it("renders Cancel button that closes the dialog", () => {
    const onOpenChange = vi.fn();
    render(
      <ResearchGenerateDialog open={true} onOpenChange={onOpenChange} />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("defaults article count to 5 and youtube count to 3", () => {
    render(
      <ResearchGenerateDialog open={true} onOpenChange={() => {}} />,
      { wrapper },
    );
    const articleInput = screen.getByLabelText(/web articles/i) as HTMLInputElement;
    const youtubeInput = screen.getByLabelText(/youtube videos/i) as HTMLInputElement;
    expect(articleInput.value).toBe("5");
    expect(youtubeInput.value).toBe("3");
  });
});
