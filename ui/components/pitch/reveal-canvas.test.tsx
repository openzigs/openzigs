import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import RevealCanvasImpl from "./reveal-canvas-impl";

describe("RevealCanvasImpl (iframe-based)", () => {
  const sampleHtml =
    '<!doctype html><html><head><link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css"></head><body><div class="pitch-deck-wrap pitch-deck-wrap--embedded"><div class="reveal" data-deck-id="d1"><div class="slides"><section><h1>Hi</h1></section></div></div></div></body></html>';

  it("renders an iframe with the embedded HTML in srcDoc", () => {
    render(<RevealCanvasImpl html={sampleHtml} />);
    const iframe = screen.getByTestId("reveal-canvas-iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe.getAttribute("srcdoc")).toBe(sampleHtml);
  });

  it("locks the iframe sandbox down to scripts + same-origin only", () => {
    render(<RevealCanvasImpl html={sampleHtml} />);
    const iframe = screen.getByTestId("reveal-canvas-iframe");
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-same-origin");
    expect(sandbox).not.toContain("allow-top-navigation");
    expect(sandbox).not.toContain("allow-popups");
    expect(sandbox).not.toContain("allow-forms");
  });

  it("updates srcDoc when html prop changes", () => {
    const otherHtml =
      '<!doctype html><html><body><div class="reveal"><div class="slides"><section><h1>Bye</h1></section></div></div></body></html>';
    const { rerender } = render(<RevealCanvasImpl html={sampleHtml} />);
    expect(
      screen.getByTestId("reveal-canvas-iframe").getAttribute("srcdoc"),
    ).toBe(sampleHtml);
    rerender(<RevealCanvasImpl html={otherHtml} />);
    expect(
      screen.getByTestId("reveal-canvas-iframe").getAttribute("srcdoc"),
    ).toBe(otherHtml);
  });

  it("forwards wrapper clicks via onContainerClick", () => {
    const onContainerClick = vi.fn();
    render(
      <RevealCanvasImpl html={sampleHtml} onContainerClick={onContainerClick} />,
    );
    const wrap = screen.getByTestId("reveal-canvas-impl");
    fireEvent.click(wrap);
    expect(onContainerClick).toHaveBeenCalledTimes(1);
  });

  // Bug-fix 2026-04-28 — selection navigation via postMessage.
  it("queues the initial selectedSlideIndex and posts it on reveal-ready handshake", () => {
    render(<RevealCanvasImpl html={sampleHtml} selectedSlideIndex={3} />);
    const iframe = screen.getByTestId(
      "reveal-canvas-iframe",
    ) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => ({ postMessage }),
    });
    // Simulate the iframe's ready handshake.
    fireEvent(
      window,
      new MessageEvent("message", { data: { type: "openzigs:reveal-ready" } }),
    );
    expect(postMessage).toHaveBeenCalledWith(
      { type: "openzigs:navigate", index: 3 },
      "*",
    );
  });

  it("posts navigate messages to the iframe when selectedSlideIndex changes after ready", () => {
    const { rerender } = render(
      <RevealCanvasImpl html={sampleHtml} selectedSlideIndex={0} />,
    );
    const iframe = screen.getByTestId(
      "reveal-canvas-iframe",
    ) as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(iframe, "contentWindow", {
      configurable: true,
      get: () => ({ postMessage }),
    });
    // Mark ready (flush any pending — should post 0).
    fireEvent(
      window,
      new MessageEvent("message", { data: { type: "openzigs:reveal-ready" } }),
    );
    postMessage.mockClear();
    // Now change selection — should immediately post.
    rerender(<RevealCanvasImpl html={sampleHtml} selectedSlideIndex={5} />);
    expect(postMessage).toHaveBeenCalledWith(
      { type: "openzigs:navigate", index: 5 },
      "*",
    );
  });
});
