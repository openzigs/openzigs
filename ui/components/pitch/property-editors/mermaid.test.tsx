import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const parseMock = vi.fn();
vi.mock("mermaid", () => ({
  default: { parse: parseMock },
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: () => null,
}));

import MermaidEditor from "./mermaid";

const baseSlide = {
  template: "mermaid" as const,
  content: {
    heading: "Diagram",
    diagram_type: "flowchart" as const,
    source: "graph TD\nA-->B",
  },
};

beforeEach(() => {
  parseMock.mockReset();
  parseMock.mockResolvedValue(undefined);
});

describe("MermaidEditor", () => {
  it("renders the editor and the source textarea", async () => {
    render(<MermaidEditor slide={baseSlide} onChange={vi.fn()} deckId="d" />);
    expect(screen.getByTestId("prop-editor-mermaid")).toBeInTheDocument();
    expect(screen.getByTestId("prop-mm-source")).toBeInTheDocument();
    await waitFor(() => expect(parseMock).toHaveBeenCalled());
  });

  it("emits onChange when the source is edited", async () => {
    const onChange = vi.fn();
    render(<MermaidEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-mm-source"), {
      target: { value: "graph LR\nC-->D" },
    });
    expect(onChange).toHaveBeenCalled();
    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.content.source).toBe("graph LR\nC-->D");
  });

  it("propagates heading edits and emits undefined when cleared", () => {
    const onChange = vi.fn();
    render(<MermaidEditor slide={baseSlide} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-mm-heading"), {
      target: { value: "New head" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.heading).toBe("New head");
    fireEvent.change(screen.getByTestId("prop-mm-heading"), {
      target: { value: "" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.heading).toBeUndefined();
  });

  it("does not show an error when the source is whitespace-only", () => {
    render(
      <MermaidEditor
        slide={{
          ...baseSlide,
          content: { ...baseSlide.content, source: "   " },
        }}
        onChange={vi.fn()}
        deckId="d"
      />,
    );
    expect(screen.queryByTestId("prop-mm-source-error")).toBeNull();
  });
});
