"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useSocket } from "@/lib/socket-context";

export type RoomRole = "host" | "guest";
export type FsmState = "PLAYING" | "PAUSED_USER_Q" | "PAUSED_QUIZ";

export interface RoomSyncState {
  currentTimeSeconds: number;
  isPlaying: boolean;
  fsmState: FsmState;
  memberCount: number;
}

/** Drift threshold in seconds — only snap when remote/local differ by more than this */
const DRIFT_THRESHOLD = 1.5;

export function useRoomSync(
  presentationId: string,
  role: RoomRole,
  videoRef: React.RefObject<HTMLVideoElement>,
) {
  const { socket } = useSocket();
  const [roomState, setRoomState] = useState<RoomSyncState>({
    currentTimeSeconds: 0,
    isPlaying: false,
    fsmState: "PLAYING",
    memberCount: 0,
  });
  const joinedRef = useRef(false);

  useEffect(() => {
    if (!socket || !presentationId) return;

    socket.emit("room:join", { presentationId, role });
    joinedRef.current = true;

    const onRoomState = (data: { currentTimeSeconds: number; isPlaying: boolean; fsmState: FsmState }) => {
      setRoomState((prev) => ({ ...prev, ...data }));
      // Sync video to room state on join
      const video = videoRef.current;
      if (video) {
        video.currentTime = data.currentTimeSeconds;
        if (data.isPlaying) void video.play().catch(() => {});
        else video.pause();
      }
    };

    const onSyncPlayback = (data: { isPlaying: boolean; currentTimeSeconds: number; originSocketId: string }) => {
      if (data.originSocketId === socket.id) return; // ignore own echoes
      setRoomState((prev) => ({
        ...prev,
        isPlaying: data.isPlaying,
        currentTimeSeconds: data.currentTimeSeconds,
      }));

      const video = videoRef.current;
      if (!video) return;

      // Drift correction
      if (Math.abs(video.currentTime - data.currentTimeSeconds) > DRIFT_THRESHOLD) {
        video.currentTime = data.currentTimeSeconds;
      }
      if (data.isPlaying) void video.play().catch(() => {});
      else video.pause();
    };

    const onMemberJoined = (data: { memberCount: number }) => {
      setRoomState((prev) => ({ ...prev, memberCount: data.memberCount }));
    };

    const onMemberLeft = (data: { memberCount: number }) => {
      setRoomState((prev) => ({ ...prev, memberCount: data.memberCount }));
    };

    const onFsmState = (data: { fsmState: FsmState }) => {
      setRoomState((prev) => ({ ...prev, fsmState: data.fsmState }));
    };

    socket.on("room:state", onRoomState);
    socket.on("room:sync_playback", onSyncPlayback);
    socket.on("room:member_joined", onMemberJoined);
    socket.on("room:member_left", onMemberLeft);
    socket.on("room:fsm_state", onFsmState);

    return () => {
      socket.off("room:state", onRoomState);
      socket.off("room:sync_playback", onSyncPlayback);
      socket.off("room:member_joined", onMemberJoined);
      socket.off("room:member_left", onMemberLeft);
      socket.off("room:fsm_state", onFsmState);

      if (joinedRef.current) {
        socket.emit("room:leave", { presentationId });
        joinedRef.current = false;
      }
    };
  }, [socket, presentationId, role, videoRef]);

  const sendPlay = useCallback(
    (currentTimeSeconds: number) => {
      if (role !== "host" || !socket) return;
      socket.emit("host:play", { presentationId, currentTimeSeconds });
    },
    [socket, presentationId, role],
  );

  const sendPause = useCallback(
    (currentTimeSeconds: number) => {
      if (role !== "host" || !socket) return;
      socket.emit("host:pause", { presentationId, currentTimeSeconds });
    },
    [socket, presentationId, role],
  );

  const sendSeek = useCallback(
    (currentTimeSeconds: number) => {
      if (role !== "host" || !socket) return;
      socket.emit("host:seek", { presentationId, currentTimeSeconds });
    },
    [socket, presentationId, role],
  );

  return {
    roomState,
    sendPlay,
    sendPause,
    sendSeek,
  };
}
