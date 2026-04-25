import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import TitleEditor from "./title";

vi.mock("../regenerate-image-dialog", () => ({
  RegenerateImageDialog: ({ open }: { open: boolean }) => (
    <div data-testid="regen-mock" data-open={open} />
  ),
}));

describe("TitleEditor", () => {
  const slide = {
    template: "title" as const,
    content: { title: "Hi", subtitle: "Sub", eyebrow: "Eye" },
  };

  it("renders fields populated from the slide", () => {
    render(
      <TitleEditor
        slide={slide}
        onChange={vi.fn()}
        deckId="d1"
      />,
    );
    expect(
      (screen.getByTestId("prop-title-title") as HTMLInputElement).value,
    ).toBe("Hi");
    expect(
      (screen.getByTestId("prop-title-subtitle") as HTMLTextAreaElement).value,
    ).toBe("Sub");
  });

  it("emits onChange with merged content when title is edited", () => {
    const onChange = vi.fn();
    render(
      <TitleEditor slide={slide} onChange={onChange} deckId="d1" />,
    );
    fireEvent.change(screen.getByTestId("prop-title-title"), {
      target: { value: "Hello" },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        template: "title",
        content: expect.objectContaining({ title: "Hello", subtitle: "Sub" }),
      }),
    );
  });

  it("opens the regenerate-image dialog when its button is clicked", () => {
    render(
      <TitleEditor slide={slide} onChange={vi.fn()} deckId="d1" />,
    );
    fireEvent.click(screen.getByTestId("prop-title-regen-bg"));
    expect(screen.getByTestId("regen-mock").getAttribute("data-open")).toBe(
      "true",
    );
  });

  it("propagates updates to eyebrow, subtitle, and background prompt", () => {
    const onChange = vi.fn();
    render(<TitleEditor slide={slide} onChange={onChange} deckId="d1" />);
    fireEvent.change(screen.getByTestId("prop-title-eyebrow"), {
      target: { value: "New eye" },
    });
    fireEvent.change(screen.getByTestId("prop-title-subtitle"), {
      target: { value: "New sub" },
    });
    fireEvent.change(screen.getByTestId("prop-title-bg-prompt"), {
      target: { value: "lush forest" },
    });
    expect(onChange).toHaveBeenCalledTimes(3);
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last.background_image_prompt).toBe("lush forest");
  });

  it("clears optional fields when their values are emptied", () => {
    const onChange = vi.fn();
    render(<TitleEditor slide={slide} onChange={onChange} deckId="d1" />);
    fireEvent.change(screen.getByTestId("prop-title-eyebrow"), {
      target: { value: "" },
    });
    const next = onChange.mock.calls.at(-1)?.[0];
    expect(next.content.eyebrow).toBeUndefined();
  });

  it("renders with empty defaults when optional fields are undefined", () => {
    const empty = {
      template: "title" as const,
      content: { title: "" },
    };
    const onChange = vi.fn();
    render(<TitleEditor slide={empty} onChange={onChange} deckId="" />);
    expect(
      (screen.getByTestId("prop-title-eyebrow") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByTestId("prop-title-subtitle") as HTMLTextAreaElement)
        .value,
    ).toBe("");
    expect(
      (screen.getByTestId("prop-title-bg-prompt") as HTMLTextAreaElement)
        .value,
    ).toBe("");
  });

  it("clears the subtitle and background prompt when their values are emptied", () => {
    const populated = {
      template: "title" as const,
      content: { title: "T", subtitle: "S", eyebrow: "E" },
      background_image_prompt: "bg",
    };
    const onChange = vi.fn();
    render(<TitleEditor slide={populated} onChange={onChange} deckId="d" />);
    fireEvent.change(screen.getByTestId("prop-title-subtitle"), {
      target: { value: "" },
    });
    expect(onChange.mock.calls.at(-1)?.[0].content.subtitle).toBeUndefined();
    fireEvent.change(screen.getByTestId("prop-title-bg-prompt"), {
      target: { value: "" },
    });
    expect(
      onChange.mock.calls.at(-1)?.[0].background_image_prompt,
    ).toBeUndefined();
  });

  it("uses the slide id when present and a non-title fallback prompt", () => {
    const populated = {
      template: "title" as const,
      content: { title: "T", subtitle: "S", eyebrow: "E" },
      background_image_prompt: "bg",
      id: "slide-x",
    };
    render(<TitleEditor slide={populated} onChange={vi.fn()} deckId="d" />);
    fireEvent.click(screen.getByTestId("prop-title-regen-bg"));
    expect(screen.getByTestId("regen-mock").getAttribute("data-open")).toBe(
      "true",
    );
  });
});
