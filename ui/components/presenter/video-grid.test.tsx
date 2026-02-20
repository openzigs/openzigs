import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { VideoGrid } from "./video-grid";
import type { RemotePeer } from "@/hooks/useVoiceRoom";

/* ── Helpers ──────────────────────────────────────────────── */

function makeFakeStream(opts?: { videoEnabled?: boolean }): MediaStream {
  const videoEnabled = opts?.videoEnabled ?? true;
  return {
    getAudioTracks: () => [{ enabled: true, kind: "audio" }],
    getVideoTracks: () => [{ enabled: videoEnabled, kind: "video" }],
    getTracks: () => [
      { enabled: true, kind: "audio" },
      { enabled: videoEnabled, kind: "video" },
    ],
  } as unknown as MediaStream;
}

function makeRemotePeer(id: string): RemotePeer {
  return { peerId: id, stream: makeFakeStream() };
}

/* ── Tests ────────────────────────────────────────────────── */

describe("VideoGrid", () => {
  it("renders 'You' tile for local stream", () => {
    render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={[]}
        isAudioMuted={false}
        isVideoMuted={false}
        onToggleAudio={vi.fn()}
        onToggleVideo={vi.fn()}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("1 in call")).toBeInTheDocument();
  });

  it("renders remote peer tiles", () => {
    const remotes: RemotePeer[] = [
      makeRemotePeer("abcd1234"),
      makeRemotePeer("efgh5678"),
    ];
    render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={remotes}
        isAudioMuted={false}
        isVideoMuted={false}
        onToggleAudio={vi.fn()}
        onToggleVideo={vi.fn()}
      />,
    );
    expect(screen.getByText("Peer abcd")).toBeInTheDocument();
    expect(screen.getByText("Peer efgh")).toBeInTheDocument();
    expect(screen.getByText("3 in call")).toBeInTheDocument();
  });

  it("calls onToggleAudio when mic button is clicked", () => {
    const onToggleAudio = vi.fn();
    render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={[]}
        isAudioMuted={true}
        isVideoMuted={false}
        onToggleAudio={onToggleAudio}
        onToggleVideo={vi.fn()}
      />,
    );
    // The A/V controls contain a mute/unmute button
    fireEvent.click(screen.getByTitle("Unmute mic"));
    expect(onToggleAudio).toHaveBeenCalledOnce();
  });

  it("calls onToggleVideo when video button is clicked", () => {
    const onToggleVideo = vi.fn();
    render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={[]}
        isAudioMuted={false}
        isVideoMuted={true}
        onToggleAudio={vi.fn()}
        onToggleVideo={onToggleVideo}
      />,
    );
    fireEvent.click(screen.getByTitle("Turn on camera"));
    expect(onToggleVideo).toHaveBeenCalledOnce();
  });

  it("shows mic muted indicator on local tile when audio is muted", () => {
    render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={[]}
        isAudioMuted={true}
        isVideoMuted={false}
        onToggleAudio={vi.fn()}
        onToggleVideo={vi.fn()}
      />,
    );
    // Mute button should show "Unmute mic" title
    expect(screen.getByTitle("Unmute mic")).toBeInTheDocument();
  });

  it("does not render local tile when localStream is null", () => {
    render(
      <VideoGrid
        localStream={null}
        remoteStreams={[makeRemotePeer("abcd1234")]}
        isAudioMuted={false}
        isVideoMuted={false}
        onToggleAudio={vi.fn()}
        onToggleVideo={vi.fn()}
      />,
    );
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.getByText("Peer abcd")).toBeInTheDocument();
  });

  it("uses correct grid class for 2 participants", () => {
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={[makeRemotePeer("peer1111")]}
        isAudioMuted={false}
        isVideoMuted={false}
        onToggleAudio={vi.fn()}
        onToggleVideo={vi.fn()}
      />,
    );
    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain("grid-cols-2");
  });

  it("uses 2x2 grid for 3-4 participants", () => {
    const remotes = [
      makeRemotePeer("aaaa1111"),
      makeRemotePeer("bbbb2222"),
      makeRemotePeer("cccc3333"),
    ];
    const { container } = render(
      <VideoGrid
        localStream={makeFakeStream()}
        remoteStreams={remotes}
        isAudioMuted={false}
        isVideoMuted={false}
        onToggleAudio={vi.fn()}
        onToggleVideo={vi.fn()}
      />,
    );
    const grid = container.querySelector(".grid");
    expect(grid?.className).toContain("grid-cols-2");
    expect(grid?.className).toContain("grid-rows-2");
  });
});
