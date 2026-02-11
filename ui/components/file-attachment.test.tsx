import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import {
  AttachmentChip,
  FileAttachmentButton,
  FileDropZone,
  AttachmentBar,
} from "./file-attachment";
import type { ChatAttachment } from "@/lib/types";

const makeAttachment = (name = "readme.md"): ChatAttachment => ({
  type: "file",
  path: name,
  name,
});

describe("AttachmentChip", () => {
  it("renders the file name", () => {
    const onRemove = vi.fn();
    render(<AttachmentChip attachment={makeAttachment("report.pdf")} onRemove={onRemove} />);
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("calls onRemove when the X button is clicked", () => {
    const onRemove = vi.fn();
    render(<AttachmentChip attachment={makeAttachment("file.ts")} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /remove file\.ts/i }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

describe("FileAttachmentButton", () => {
  it("renders the attach button", () => {
    render(
      <FileAttachmentButton
        onAttach={vi.fn()}
        disabled={false}
        attachmentCount={0}
      />
    );
    expect(screen.getByRole("button", { name: /attach files/i })).toBeInTheDocument();
  });

  it("disables when attachment limit reached", () => {
    render(
      <FileAttachmentButton
        onAttach={vi.fn()}
        disabled={false}
        attachmentCount={10}
      />
    );
    expect(screen.getByRole("button", { name: /attach files/i })).toBeDisabled();
  });

  it("disables when explicitly disabled", () => {
    render(
      <FileAttachmentButton
        onAttach={vi.fn()}
        disabled={true}
        attachmentCount={0}
      />
    );
    expect(screen.getByRole("button", { name: /attach files/i })).toBeDisabled();
  });
});

describe("FileDropZone", () => {
  it("renders children", () => {
    render(
      <FileDropZone onDrop={vi.fn()} attachmentCount={0}>
        <span>Drop area</span>
      </FileDropZone>
    );
    expect(screen.getByText("Drop area")).toBeInTheDocument();
  });
});

describe("AttachmentBar", () => {
  it("renders nothing when empty", () => {
    const { container } = render(
      <AttachmentBar attachments={[]} onRemove={vi.fn()} />
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders chips for each attachment", () => {
    const attachments: ChatAttachment[] = [
      makeAttachment("a.ts"),
      makeAttachment("b.ts"),
    ];
    render(<AttachmentBar attachments={attachments} onRemove={vi.fn()} />);
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.getByText("b.ts")).toBeInTheDocument();
  });

  it("calls onRemove with the correct index", () => {
    const onRemove = vi.fn();
    const attachments: ChatAttachment[] = [
      makeAttachment("first.ts"),
      makeAttachment("second.ts"),
    ];
    render(<AttachmentBar attachments={attachments} onRemove={onRemove} />);
    fireEvent.click(screen.getByRole("button", { name: /remove second\.ts/i }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });
});
