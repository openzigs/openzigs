import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { AudioManager } from "./audio-manager";

describe("AudioManager", () => {
  const musicTrack = {
    track: "/audio/soundtrack.mp3",
    volume: 0.8,
    loop: true,
    ducking: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };

  it("renders the panel", () => {
    render(<AudioManager music={musicTrack} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByTestId("audio-manager")).toBeInTheDocument();
  });

  it("displays track name from music src", () => {
    render(<AudioManager music={musicTrack} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByTestId("track-name")).toHaveTextContent("soundtrack.mp3");
  });

  it("shows volume slider", () => {
    render(<AudioManager music={musicTrack} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByTestId("volume-slider")).toBeInTheDocument();
  });

  it("updates volume when slider changes", () => {
    const onMusicChange = vi.fn();
    render(<AudioManager music={musicTrack} onMusicChange={onMusicChange} fps={30} />);
    const slider = screen.getByTestId("volume-slider");
    fireEvent.change(slider, { target: { value: "0.5" } });
    expect(onMusicChange).toHaveBeenCalled();
    const updated = onMusicChange.mock.calls[0][0];
    expect(updated.volume).toBe(0.5);
  });

  it("shows ducking toggle", () => {
    render(<AudioManager music={musicTrack} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByTestId("toggle-ducking")).toBeInTheDocument();
  });

  it("shows loop toggle", () => {
    render(<AudioManager music={musicTrack} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByTestId("toggle-loop")).toBeInTheDocument();
  });

  it("toggles ducking", () => {
    const onMusicChange = vi.fn();
    render(<AudioManager music={musicTrack} onMusicChange={onMusicChange} fps={30} />);
    fireEvent.click(screen.getByTestId("toggle-ducking"));
    expect(onMusicChange).toHaveBeenCalled();
    const updated = onMusicChange.mock.calls[0][0];
    expect(updated.ducking).toBe(true);
  });

  it("shows no music message when music is null", () => {
    render(<AudioManager music={null} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByText(/no music track/i)).toBeInTheDocument();
  });

  it("shows remove button when music exists", () => {
    render(<AudioManager music={musicTrack} onMusicChange={vi.fn()} fps={30} />);
    expect(screen.getByTestId("remove-music")).toBeInTheDocument();
  });

  it("removes music on remove click", () => {
    const onMusicChange = vi.fn();
    render(<AudioManager music={musicTrack} onMusicChange={onMusicChange} fps={30} />);
    fireEvent.click(screen.getByTestId("remove-music"));
    expect(onMusicChange).toHaveBeenCalledWith(null);
  });
});
