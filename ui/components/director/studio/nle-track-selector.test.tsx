import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  NleTrackSelector,
  NleDownloadButton,
  downloadFile,
  type ExportTrack,
} from "./nle-track-selector";

describe("NleTrackSelector", () => {
  it("renders all 4 tracks with current selection", () => {
    const value = new Set<ExportTrack>(["video", "audio"]);
    render(<NleTrackSelector value={value} onChange={() => {}} />);
    expect(
      (screen.getByLabelText("Include Video track") as HTMLInputElement)
        .checked,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Include Captions track") as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("toggles tracks on change", () => {
    const onChange = vi.fn();
    const value = new Set<ExportTrack>(["video"]);
    render(<NleTrackSelector value={value} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Include Audio track"));
    const next = onChange.mock.calls[0][0] as Set<ExportTrack>;
    expect(next.has("audio")).toBe(true);
    expect(next.has("video")).toBe(true);
  });

  it("removes a track on second toggle", () => {
    const onChange = vi.fn();
    const value = new Set<ExportTrack>(["video", "captions"]);
    render(<NleTrackSelector value={value} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Include Captions track"));
    const next = onChange.mock.calls[0][0] as Set<ExportTrack>;
    expect(next.has("captions")).toBe(false);
  });
});

describe("downloadFile", () => {
  it("creates and clicks an anchor element with download attribute", () => {
    const append = vi.spyOn(document.body, "appendChild");
    const remove = vi.spyOn(document.body, "removeChild");
    downloadFile({ url: "https://x/file.mp4", filename: "out.mp4" });
    const anchor = append.mock.calls[0][0] as HTMLAnchorElement;
    expect(anchor.tagName).toBe("A");
    expect(anchor.href).toBe("https://x/file.mp4");
    expect(anchor.download).toBe("out.mp4");
    expect(remove).toHaveBeenCalled();
  });
});

describe("NleDownloadButton", () => {
  it("is disabled when url is missing", () => {
    render(<NleDownloadButton filename="x.mp4" />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("triggers download when clicked", () => {
    const append = vi.spyOn(document.body, "appendChild");
    render(<NleDownloadButton url="blob:foo" filename="x.mp4" />);
    fireEvent.click(screen.getByRole("button"));
    expect(append).toHaveBeenCalled();
  });
});
