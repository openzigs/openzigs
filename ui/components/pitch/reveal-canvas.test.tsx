import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Track Reveal lifecycle. The mock has to live above the import.
const initializeMock = vi.fn().mockResolvedValue(undefined);
const destroyMock = vi.fn();
const ctorMock = vi.fn();

vi.mock("reveal.js", () => {
  return {
    default: class MockReveal {
      constructor(el: HTMLElement, opts: Record<string, unknown>) {
        ctorMock(el, opts);
      }
      initialize = initializeMock;
      destroy = destroyMock;
    },
  };
});

import RevealCanvasImpl from "./reveal-canvas-impl";

describe("RevealCanvasImpl", () => {
  beforeEach(() => {
    initializeMock.mockClear();
    destroyMock.mockClear();
    ctorMock.mockClear();
  });

  const sampleHtml =
    '<div class="pitch-deck-wrap"><div class="reveal" data-deck-id="d1"><div class="slides"><section><h1>Hi</h1></section></div></div></div>';

  it("renders the embedded HTML and initializes Reveal once", () => {
    render(<RevealCanvasImpl html={sampleHtml} />);
    expect(screen.getByTestId("reveal-canvas-impl")).toBeInTheDocument();
    expect(ctorMock).toHaveBeenCalledTimes(1);
    expect(initializeMock).toHaveBeenCalledTimes(1);

    const [el, opts] = ctorMock.mock.calls[0]!;
    expect((el as HTMLElement).classList.contains("reveal")).toBe(true);
    expect(opts).toMatchObject({
      embedded: true,
      hash: false,
      controls: true,
      progress: true,
    });
  });

  it("calls Reveal.destroy on unmount", () => {
    const { unmount } = render(<RevealCanvasImpl html={sampleHtml} />);
    expect(destroyMock).not.toHaveBeenCalled();
    unmount();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-init when html prop is unchanged across re-render", () => {
    const { rerender } = render(<RevealCanvasImpl html={sampleHtml} />);
    expect(ctorMock).toHaveBeenCalledTimes(1);
    rerender(<RevealCanvasImpl html={sampleHtml} />);
    expect(ctorMock).toHaveBeenCalledTimes(1);
  });

  it("re-initializes when html prop changes", () => {
    const otherHtml =
      '<div class="pitch-deck-wrap"><div class="reveal"><div class="slides"><section><h1>Bye</h1></section></div></div></div>';
    const { rerender } = render(<RevealCanvasImpl html={sampleHtml} />);
    rerender(<RevealCanvasImpl html={otherHtml} />);
    expect(destroyMock).toHaveBeenCalledTimes(1);
    expect(ctorMock).toHaveBeenCalledTimes(2);
  });

  it("forwards container clicks via onContainerClick", () => {
    const onContainerClick = vi.fn();
    const { container } = render(
      <RevealCanvasImpl html={sampleHtml} onContainerClick={onContainerClick} />,
    );
    const h1 = container.querySelector("h1");
    expect(h1).toBeTruthy();
    h1!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onContainerClick).toHaveBeenCalledTimes(1);
    expect(onContainerClick.mock.calls[0]![0]).toBe(h1);
  });
});
