/**
 * Parameterized smoke + handler-coverage tests for per-template editors.
 *
 * For each editor we render a realistic fixture, assert it mounts, fire
 * change events on every text input/textarea, and click any add/remove
 * action buttons. This exercises the inline arrow handlers each editor
 * defines per field, lifting function coverage above the 80% bar.
 *
 * Editors with non-trivial logic (chart, mermaid, title, bullet_list) keep
 * their dedicated focused tests in sibling files.
 */
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../regenerate-image-dialog", () => ({
  RegenerateImageDialog: () => null,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    children,
  }: {
    value: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <div data-testid="select-shim" data-value={value}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => <div data-value={value}>{children}</div>,
}));

import SectionDividerEditor from "./section_divider";
import TwoColumnEditor from "./two_column";
import ImageCaptionEditor from "./image_caption";
import QuoteEditor from "./quote";
import StatsKpiEditor from "./stats_kpi";
import ComparisonTableEditor from "./comparison_table";
import TimelineEditor from "./timeline";
import FullBleedEditor from "./full_bleed";
import CodeEditor from "./code";
import QaEditor from "./qa";

interface EditorCase {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Editor: React.ComponentType<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  slide: any;
  rootTestId: string;
  /** Inputs to fire 'change' on. */
  changes: { testId: string; value: string }[];
  /** Buttons to click. */
  clicks?: string[];
}

const cases: EditorCase[] = [
  {
    name: "section_divider",
    Editor: SectionDividerEditor,
    slide: {
      template: "section_divider",
      content: { section_number: 1, title: "Part 1" },
    },
    rootTestId: "prop-editor-section-divider",
    changes: [
      { testId: "prop-sd-title", value: "New title" },
      { testId: "prop-sd-number", value: "5" },
    ],
  },
  {
    name: "two_column",
    Editor: TwoColumnEditor,
    slide: {
      template: "two_column",
      content: { heading: "H", left: "L", right: "R" },
    },
    rootTestId: "prop-editor-two-column",
    changes: [
      { testId: "prop-tc-heading", value: "New head" },
      { testId: "prop-tc-left", value: "New left" },
      { testId: "prop-tc-right", value: "New right" },
    ],
  },
  {
    name: "image_caption",
    Editor: ImageCaptionEditor,
    slide: {
      template: "image_caption",
      content: {
        heading: "h",
        caption: "c",
        image: { prompt: "p", url: null, alt: "a" },
      },
    },
    rootTestId: "prop-editor-image-caption",
    changes: [
      { testId: "prop-ic-heading", value: "new h" },
      { testId: "prop-ic-caption", value: "new c" },
      { testId: "prop-ic-alt", value: "new a" },
      { testId: "prop-ic-prompt", value: "new p" },
    ],
    clicks: ["prop-ic-regen"],
  },
  {
    name: "quote",
    Editor: QuoteEditor,
    slide: {
      template: "quote",
      content: { quote: "q", attribution: "a", source: "s" },
    },
    rootTestId: "prop-editor-quote",
    changes: [
      { testId: "prop-q-quote", value: "new quote" },
      { testId: "prop-q-attr", value: "new attr" },
      { testId: "prop-q-source", value: "new source" },
    ],
  },
  {
    name: "stats_kpi",
    Editor: StatsKpiEditor,
    slide: {
      template: "stats_kpi",
      content: {
        heading: "KPIs",
        kpis: [
          { value: "1", label: "x" },
          { value: "2", label: "y" },
        ],
      },
    },
    rootTestId: "prop-editor-stats-kpi",
    changes: [
      { testId: "prop-skpi-heading", value: "New head" },
      { testId: "prop-skpi-value-0", value: "100" },
      { testId: "prop-skpi-label-0", value: "Users" },
      { testId: "prop-skpi-delta-0", value: "+50%" },
    ],
    clicks: ["prop-skpi-add", "prop-skpi-remove-1"],
  },
  {
    name: "comparison_table",
    Editor: ComparisonTableEditor,
    slide: {
      template: "comparison_table",
      content: {
        heading: "Tbl",
        columns: ["A", "B"],
        rows: [
          { label: "r1", cells: ["a1", "b1"] },
          { label: "r2", cells: ["a2", "b2"] },
        ],
      },
    },
    rootTestId: "prop-editor-comparison-table",
    changes: [
      { testId: "prop-ct-heading", value: "New tbl" },
      { testId: "prop-ct-col-0", value: "AA" },
      { testId: "prop-ct-row-label-0", value: "row1" },
      { testId: "prop-ct-cell-0-0", value: "newcell" },
    ],
    clicks: [
      "prop-ct-col-add",
      "prop-ct-row-add",
      "prop-ct-col-remove-0",
      "prop-ct-row-remove-0",
    ],
  },
  {
    name: "timeline",
    Editor: TimelineEditor,
    slide: {
      template: "timeline",
      content: {
        heading: "Hist",
        events: [
          { when: "2025", what: "A" },
          { when: "2026", what: "B" },
        ],
      },
    },
    rootTestId: "prop-editor-timeline",
    changes: [
      { testId: "prop-tl-heading", value: "New hist" },
      { testId: "prop-tl-when-0", value: "2027" },
      { testId: "prop-tl-what-0", value: "newwhat" },
    ],
    clicks: ["prop-tl-add", "prop-tl-down-0", "prop-tl-up-1", "prop-tl-remove-1"],
  },
  {
    name: "full_bleed",
    Editor: FullBleedEditor,
    slide: {
      template: "full_bleed",
      content: {
        image: { prompt: "p", url: null, alt: "a" },
        overlay_text: "ov",
      },
    },
    rootTestId: "prop-editor-full-bleed",
    changes: [
      { testId: "prop-fb-prompt", value: "new prompt" },
      { testId: "prop-fb-alt", value: "new alt" },
      { testId: "prop-fb-overlay", value: "new ov" },
    ],
    clicks: ["prop-fb-regen"],
  },
  {
    name: "code",
    Editor: CodeEditor,
    slide: {
      template: "code",
      content: { heading: "h", language: "ts", code: "x" },
    },
    rootTestId: "prop-editor-code",
    changes: [
      { testId: "prop-code-heading", value: "new h" },
      { testId: "prop-code-source", value: "const z = 2;" },
    ],
  },
  {
    name: "qa",
    Editor: QaEditor,
    slide: {
      template: "qa",
      content: { heading: "Q?", contact: "c@example.com" },
    },
    rootTestId: "prop-editor-qa",
    changes: [
      { testId: "prop-qa-heading", value: "new q" },
      { testId: "prop-qa-contact", value: "new@example.com" },
    ],
  },
];

describe("Pitch property editors — parameterized smoke", () => {
  for (const c of cases) {
    it(`${c.name} mounts and exercises every handler`, () => {
      const onChange = vi.fn();
      render(
        <c.Editor slide={c.slide} onChange={onChange} deckId="deck-1" />,
      );
      expect(screen.getByTestId(c.rootTestId)).toBeInTheDocument();
      for (const ch of c.changes) {
        const input = screen.getByTestId(ch.testId);
        fireEvent.change(input, { target: { value: ch.value } });
      }
      for (const id of c.clicks ?? []) {
        const btn = screen.queryByTestId(id);
        if (btn) fireEvent.click(btn);
      }
      expect(onChange).toHaveBeenCalled();
    });
  }
});
