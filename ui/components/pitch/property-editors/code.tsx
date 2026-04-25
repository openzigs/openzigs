"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel, TextArea, TextInput, type PropertyEditorProps } from "./shared";

interface CodeSlide {
  template: "code";
  content: {
    heading?: string;
    language: string;
    code: string;
    highlight_lines?: number[];
  };
  speaker_notes?: string;
  source_anchor?: string;
}

const LANGUAGES = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "csharp",
  "ruby",
  "php",
  "bash",
  "shell",
  "powershell",
  "sql",
  "yaml",
  "json",
  "html",
  "css",
  "markdown",
  "text",
];

const CodeEditor = ({ slide, onChange }: PropertyEditorProps<CodeSlide>) => {
  const c = slide.content;
  const update = (patch: Partial<CodeSlide["content"]>) =>
    onChange({ ...slide, content: { ...c, ...patch } });

  return (
    <div data-testid="prop-editor-code">
      <FieldLabel label="Heading (optional)">
        <TextInput
          testId="prop-code-heading"
          value={c.heading ?? ""}
          maxLength={120}
          onChange={(v) => update({ heading: v || undefined })}
        />
      </FieldLabel>
      <FieldLabel label="Language">
        <Select
          value={c.language}
          onValueChange={(v) => update({ language: v })}
        >
          <SelectTrigger
            data-testid="prop-code-lang-trigger"
            className="h-8 text-xs"
          >
            <SelectValue placeholder="Pick a language" />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem
                key={l}
                value={l}
                data-testid={`prop-code-lang-${l}`}
              >
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FieldLabel>
      <FieldLabel label="Code">
        <TextArea
          testId="prop-code-source"
          value={c.code}
          maxLength={4000}
          rows={10}
          monospace
          onChange={(v) => update({ code: v })}
        />
      </FieldLabel>
    </div>
  );
};

export default CodeEditor;
