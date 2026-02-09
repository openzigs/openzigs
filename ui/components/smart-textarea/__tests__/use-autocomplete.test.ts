import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAutocomplete, type AutocompleteItem } from "../use-autocomplete";

const tools: AutocompleteItem[] = [
  { value: "web-search", label: "web-search", description: "Search the web", kind: "tools" },
  { value: "file-read", label: "file-read", description: "Read a file", kind: "tools" },
  { value: "shell-execute", label: "shell-execute", description: "Run shell command", kind: "tools" },
];

const prompts: AutocompleteItem[] = [
  { value: "daily-standup", label: "daily-standup", description: "Morning standup template", kind: "commands" },
  { value: "code-review", label: "code-review", description: "PR review template", kind: "commands" },
];

const models: AutocompleteItem[] = [
  { value: "gpt-4.1", label: "gpt-4.1", kind: "models" },
  { value: "claude-sonnet-4", label: "claude-sonnet-4", kind: "models" },
];

const ALL_ITEMS = [...tools, ...prompts, ...models];

function createTextareaRef(selectionStart = 0) {
  return {
    current: {
      selectionStart,
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    } as unknown as HTMLTextAreaElement,
  };
}

describe("useAutocomplete", () => {
  it("should not open when no trigger character is typed", () => {
    const ref = createTextareaRef(5);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "hello",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(false);
    expect(result.current.triggerKind).toBeNull();
  });

  it("should open with tools kind when # is typed", () => {
    const ref = createTextareaRef(1);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "#",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(true);
    expect(result.current.triggerKind).toBe("tools");
    expect(result.current.filtered.length).toBe(3);
  });

  it("should open with commands kind when / is typed", () => {
    const ref = createTextareaRef(1);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "/",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(true);
    expect(result.current.triggerKind).toBe("commands");
    expect(result.current.filtered.length).toBe(2);
  });

  it("should open with models kind when @ is typed", () => {
    const ref = createTextareaRef(1);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "@",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(true);
    expect(result.current.triggerKind).toBe("models");
    expect(result.current.filtered.length).toBe(2);
  });

  it("should filter items based on query after trigger", () => {
    const ref = createTextareaRef(5);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "#web-",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(true);
    expect(result.current.query).toBe("web-");
    expect(result.current.filtered.length).toBe(1);
    expect(result.current.filtered[0].value).toBe("web-search");
  });

  it("should detect trigger after whitespace", () => {
    const ref = createTextareaRef(17);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "please use #shell",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(true);
    expect(result.current.triggerKind).toBe("tools");
    expect(result.current.query).toBe("shell");
  });

  it("should not trigger when preceded by non-whitespace", () => {
    const ref = createTextareaRef(6);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "hello#",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(false);
  });

  it("should insert selected item and reset state", () => {
    const onChange = vi.fn();
    const ref = createTextareaRef(5);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "#web-",
        onChange,
        textareaRef: ref,
      })
    );

    act(() => {
      result.current.onSelect(result.current.filtered[0]);
    });

    expect(onChange).toHaveBeenCalledWith("web-search ");
    expect(result.current.open).toBe(false);
  });

  it("should dismiss and stop showing popover", () => {
    const ref = createTextareaRef(1);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "#",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );

    expect(result.current.open).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.open).toBe(false);
  });

  it("should work with trigger at start after existing text", () => {
    const ref = createTextareaRef(18);
    const { result } = renderHook(() =>
      useAutocomplete({
        items: ALL_ITEMS,
        value: "tell me about @gpt",
        onChange: vi.fn(),
        textareaRef: ref,
      })
    );
    expect(result.current.open).toBe(true);
    expect(result.current.triggerKind).toBe("models");
    expect(result.current.query).toBe("gpt");
    expect(result.current.filtered.length).toBe(1);
    expect(result.current.filtered[0].value).toBe("gpt-4.1");
  });
});
