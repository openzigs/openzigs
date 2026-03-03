import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TimelineTracks } from "./timeline-tracks";
import type { TimelineTrack, DirectorManifest } from "../types";

const makeTracks = (): TimelineTrack[] => [
  {
    id: "scenes",
    label: "Scenes",
    type: "scenes",
    entries: [
      { timelineIndex: 0, startFrame: 0, durationFrames: 90, label: "Scene 1", color: "bg-blue-500/70" },
      { timelineIndex: 2, startFrame: 90, durationFrames: 90, label: "Scene 2", color: "bg-blue-500/70" },
      { timelineIndex: 4, startFrame: 180, durationFrames: 90, label: "Scene 3", color: "bg-blue-500/70" },
    ],
  },
  {
    id: "voiceover",
    label: "Voiceover",
    type: "voiceover",
    entries: [
      { timelineIndex: 0, startFrame: 0, durationFrames: 90, label: "VO 1", color: "bg-purple-500/70" },
    ],
  },
  {
    id: "audio",
    label: "Audio",
    type: "audio",
    entries: [
      { timelineIndex: -1, startFrame: 0, durationFrames: 270, label: "Music", color: "bg-orange-500/70" },
    ],
  },
];

const makeManifest = (): DirectorManifest => ({
  projectTitle: "Test",
  composition: { width: 1920, height: 1080, fps: 30 },
  timeline: [
    { type: "image_scene", startAtFrame: 0, duration: 90, scriptText: "Scene 1" },
    { type: "transition", startAtFrame: 90, duration: 15, style: "crossfade" },
    { type: "image_scene", startAtFrame: 90, duration: 90, scriptText: "Scene 2" },
    { type: "transition", startAtFrame: 180, duration: 15, style: "crossfade" },
    { type: "image_scene", startAtFrame: 180, duration: 90, scriptText: "Scene 3" },
  ],
});

describe("TimelineTracks", () => {
  const defaultProps = {
    tracks: makeTracks(),
    totalFrames: 270,
    currentFrame: 0,
    fps: 30,
    onSelectScene: vi.fn(),
    onSeek: vi.fn(),
    manifest: makeManifest(),
    onReorderScenes: vi.fn(),
  };

  it("renders the timeline container", () => {
    render(<TimelineTracks {...defaultProps} />);
    expect(screen.getByTestId("timeline-tracks")).toBeInTheDocument();
  });

  it("renders all scene entries", () => {
    render(<TimelineTracks {...defaultProps} />);
    expect(screen.getByTestId("scene-entry-0")).toBeInTheDocument();
    expect(screen.getByTestId("scene-entry-2")).toBeInTheDocument();
    expect(screen.getByTestId("scene-entry-4")).toBeInTheDocument();
  });

  it("renders scene labels", () => {
    render(<TimelineTracks {...defaultProps} />);
    expect(screen.getByText("Scene 1")).toBeInTheDocument();
    expect(screen.getByText("Scene 2")).toBeInTheDocument();
    expect(screen.getByText("Scene 3")).toBeInTheDocument();
  });

  it("renders track labels", () => {
    render(<TimelineTracks {...defaultProps} />);
    expect(screen.getByText("Scenes")).toBeInTheDocument();
    expect(screen.getByText("Voiceover")).toBeInTheDocument();
    expect(screen.getByText("Audio")).toBeInTheDocument();
  });

  it("renders time markers", () => {
    render(<TimelineTracks {...defaultProps} />);
    expect(screen.getByText("0:00")).toBeInTheDocument();
  });

  it("shows empty state when no entries", () => {
    const emptyTracks = makeTracks().map((t) => ({ ...t, entries: [] }));
    render(<TimelineTracks {...defaultProps} tracks={emptyTracks} />);
    expect(screen.getByText("No timeline entries")).toBeInTheDocument();
  });

  it("scene entries have grab cursor styling", () => {
    render(<TimelineTracks {...defaultProps} />);
    const entry = screen.getByTestId("scene-entry-0");
    expect(entry.className).toContain("cursor-grab");
  });

  it("non-scene entries have pointer cursor", () => {
    render(<TimelineTracks {...defaultProps} />);
    // The VO entry isn't a SortableEntry, just a regular button
    const voEntry = screen.getByText("VO 1");
    expect(voEntry.className).toContain("cursor-pointer");
  });
});
