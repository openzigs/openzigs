import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

import QuoteEditor from "./quote";
import FullBleedEditor from "./full_bleed";
import CodeEditor from "./code";
import QaEditor from "./qa";

vi.mock("../regenerate-image-dialog", () => ({
  RegenerateImageDialog: ({ open }: { open: boolean }) => (
    <div data-testid="regen-mock" data-open={open} />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value?: string;
    onValueChange?: (v: string) => void;
  }) => (
    <div
      data-testid="select-mock"
      data-value={value}
      onClick={() => onValueChange?.("python")}
    >
      {children}
    </div>
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectValue: () => null,
}));

describe("Optional-field branch coverage", () => {
  it("quote: clears source on empty input when source is preset", () => {
    const onChange = vi.fn();
    render(
      <QuoteEditor
        slide={{
          template: "quote",
          content: { quote: "q", attribution: "a", source: "s" },
        }}
        onChange={onChange}
        deckId=""
      />,
    );
    fireEvent.change(screen.getByTestId("prop-q-source"), {
      target: { value: "" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.source).toBeUndefined();
  });

  it("quote: renders an empty source when source is undefined", () => {
    render(
      <QuoteEditor
        slide={{
          template: "quote",
          content: { quote: "q", attribution: "a" },
        }}
        onChange={vi.fn()}
        deckId=""
      />,
    );
    expect(
      (screen.getByTestId("prop-q-source") as HTMLInputElement).value,
    ).toBe("");
  });

  it("full_bleed: clears overlay on empty input when overlay is preset", () => {
    const onChange = vi.fn();
    render(
      <FullBleedEditor
        slide={{
          template: "full_bleed",
          content: {
            image: { prompt: "p", url: null, alt: "a" },
            overlay_text: "ov",
          },
        }}
        onChange={onChange}
        deckId="d"
      />,
    );
    fireEvent.change(screen.getByTestId("prop-fb-overlay"), {
      target: { value: "" },
    });
    expect(
      onChange.mock.calls.at(-1)?.[0].content.overlay_text,
    ).toBeUndefined();
  });

  it("full_bleed: renders empty overlay textarea when overlay_text is undefined", () => {
    render(
      <FullBleedEditor
        slide={{
          template: "full_bleed",
          content: {
            image: { prompt: "p", url: null, alt: "a" },
          },
        }}
        onChange={vi.fn()}
        deckId="d"
      />,
    );
    expect(
      (screen.getByTestId("prop-fb-overlay") as HTMLTextAreaElement).value,
    ).toBe("");
  });

  it("code: clears heading on empty input when heading is preset", () => {
    const onChange = vi.fn();
    render(
      <CodeEditor
        slide={{
          template: "code",
          content: { language: "typescript", code: "x", heading: "H" },
        }}
        onChange={onChange}
        deckId=""
      />,
    );
    fireEvent.change(screen.getByTestId("prop-code-heading"), {
      target: { value: "" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.heading).toBeUndefined();
  });

  it("code: renders empty heading input when heading is undefined", () => {
    render(
      <CodeEditor
        slide={{
          template: "code",
          content: { language: "typescript", code: "x" },
        }}
        onChange={vi.fn()}
        deckId=""
      />,
    );
    expect(
      (screen.getByTestId("prop-code-heading") as HTMLInputElement).value,
    ).toBe("");
  });

  it("qa: clears contact on empty input when contact is preset", () => {
    const onChange = vi.fn();
    render(
      <QaEditor
        slide={{
          template: "qa",
          content: { heading: "Q?", contact: "@me" },
        }}
        onChange={onChange}
        deckId=""
      />,
    );
    fireEvent.change(screen.getByTestId("prop-qa-contact"), {
      target: { value: "" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.contact).toBeUndefined();
  });

  it("qa: renders empty contact when contact is undefined and supports heading edits", () => {
    const onChange = vi.fn();
    render(
      <QaEditor
        slide={{
          template: "qa",
          content: { heading: "Q?" },
        }}
        onChange={onChange}
        deckId=""
      />,
    );
    expect(
      (screen.getByTestId("prop-qa-contact") as HTMLInputElement).value,
    ).toBe("");
    fireEvent.change(screen.getByTestId("prop-qa-heading"), {
      target: { value: "What now?" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.heading).toBe("What now?");
  });

  it("qa: falls back to default heading when content.heading is absent", () => {
    render(
      <QaEditor
        slide={{
          template: "qa",
          content: { heading: undefined as unknown as string },
        }}
        onChange={vi.fn()}
        deckId=""
      />,
    );
    expect(
      (screen.getByTestId("prop-qa-heading") as HTMLInputElement).value,
    ).toBe("Questions?");
  });
});
