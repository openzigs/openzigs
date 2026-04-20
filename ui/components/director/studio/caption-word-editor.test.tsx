import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CaptionWordEditor, type CaptionWord } from "./caption-word-editor";
import { CaptionTemplatePreview } from "./caption-template-preview";

const sampleWords: CaptionWord[] = [
  { word: "Hello", start: 0, end: 30 },
  { word: "world", start: 30, end: 60 },
  { word: "today", start: 60, end: 90 },
];

describe("CaptionWordEditor", () => {
  it("renders empty state when no words", () => {
    const onChange = vi.fn();
    render(<CaptionWordEditor words={[]} onChange={onChange} />);
    expect(screen.getByText(/no caption words/i)).toBeInTheDocument();
  });

  it("lists each word as a selectable option", () => {
    render(<CaptionWordEditor words={sampleWords} onChange={vi.fn()} />);
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("selects a word and shows timing/color controls", () => {
    render(<CaptionWordEditor words={sampleWords} onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId("word-1"));
    expect(screen.getByLabelText("Decrease start")).toBeInTheDocument();
    expect(screen.getByLabelText("Color #FFD700")).toBeInTheDocument();
  });

  it("applies a color override on click", () => {
    const onChange = vi.fn();
    render(<CaptionWordEditor words={sampleWords} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("word-0"));
    fireEvent.click(screen.getByLabelText("Color #ef4444"));
    expect(onChange).toHaveBeenCalledWith([
      { word: "Hello", start: 0, end: 30, color: "#ef4444" },
      sampleWords[1],
      sampleWords[2],
    ]);
  });

  it("adjusts start frame and respects start < end ordering", () => {
    const onChange = vi.fn();
    render(<CaptionWordEditor words={sampleWords} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("word-0"));
    fireEvent.click(screen.getByLabelText("Increase start"));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...sampleWords[0], start: 1 },
      sampleWords[1],
      sampleWords[2],
    ]);
  });

  it("rejects timing edits that violate start < end", () => {
    const onChange = vi.fn();
    const tightWords: CaptionWord[] = [{ word: "x", start: 5, end: 6 }];
    render(<CaptionWordEditor words={tightWords} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("word-0"));
    fireEvent.click(screen.getByLabelText("Increase start"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles emphasis style", () => {
    const onChange = vi.fn();
    render(<CaptionWordEditor words={sampleWords} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("word-2"));
    fireEvent.click(screen.getByRole("button", { name: "bold" }));
    expect(onChange).toHaveBeenCalledWith([
      sampleWords[0],
      sampleWords[1],
      { ...sampleWords[2], emphasis: "bold" },
    ]);
  });
});

describe("CaptionTemplatePreview", () => {
  const tpl = {
    id: "hormozi",
    name: "Hormozi",
    fontFamily: "Impact",
    textColor: "#ffffff",
    highlightColor: "#FFD700",
    fontSize: 80,
    position: "bottom" as const,
    supportsBrandKit: false,
  };

  it("renders the template name and sample text", () => {
    render(<CaptionTemplatePreview template={tpl} />);
    expect(screen.getByText("Hormozi")).toBeInTheDocument();
    expect(screen.getByText("This")).toBeInTheDocument();
    expect(screen.getByText("preview")).toBeInTheDocument();
  });

  it("invokes onSelect and exposes selection state", () => {
    const onSelect = vi.fn();
    render(
      <CaptionTemplatePreview template={tpl} selected onSelect={onSelect} />,
    );
    const btn = screen.getByRole("button", {
      name: /caption template: hormozi/i,
    });
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalled();
  });

  it("shows BK badge when supportsBrandKit", () => {
    render(
      <CaptionTemplatePreview template={{ ...tpl, supportsBrandKit: true }} />,
    );
    expect(screen.getByText("BK")).toBeInTheDocument();
  });
});
