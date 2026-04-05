"use client";

import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, buildUrl, buildMediaUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { usePresenterState } from "@/hooks/use-presenter-state";
import type { QuizQuestion } from "@/hooks/use-presenter-state";
import { useRoomSync } from "@/hooks/useRoomSync";
import { useMediaDevices } from "@/hooks/useMediaDevices";
import { useVoiceRoom } from "@/hooks/useVoiceRoom";
import { useVoicePipe } from "@/hooks/useVoicePipe";
import { InteractivePlayer } from "@/components/presenter/interactive-player";
import { ChapterList } from "@/components/presenter/chapter-list";
import { ChapterEditor } from "@/components/presenter/chapter-editor";
import type { UserChapter } from "@/components/presenter/chapter-editor";
import { CameraTile } from "@/components/presenter/camera-tile";
import { PresenterToolbar } from "@/components/presenter/presenter-toolbar";
import { SlideDrawer } from "@/components/presenter/slide-drawer";
import { ParticipantPanel } from "@/components/presenter/participant-panel";
import { QuizOverlay } from "@/components/presenter/quiz-overlay";
import { BlackboardOverlay } from "@/components/presenter/blackboard-overlay";
import { RecapScreen } from "@/components/presenter/recap-screen";
import { RemotePeerTiles } from "@/components/presenter/remote-peer-tiles";
import { ToastContainer } from "@/components/toast";

interface PresentationDetail {
  id: string;
  title: string;
  video_path: string;
  thumbnail_path: string | null;
  duration_seconds: number;
  fps: number;
  script_json: Array<{ text: string; startTime: number; endTime: number }>;
  chapters: Array<{ title: string; startSeconds: number; endSeconds: number }>;
  user_chapters: UserChapter[];
  voice_id: string | null;
  quiz_enabled: boolean;
  quiz_config: { timestamps: number[]; difficulty: string } | null;
  mode: string;
  created_at: string;
}

export default function PresenterPlayerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { socket } = useSocket();

  const presentationQuery = useQuery({
    queryKey: ["presentation", id],
    queryFn: () => fetchJson<PresentationDetail>(`/api/presentations/${id}`),
    enabled: !!id,
  });

  const quizQuery = useQuery({
    queryKey: ["presentation-quiz", id],
    queryFn: () =>
      fetchJson<{ questions: QuizQuestion[] }>(`/api/presentations/${id}/quiz`),
    enabled: !!id,
  });

  const presentation = presentationQuery.data;
  const quizQuestions = quizQuery.data?.questions ?? [];
  const chapters = useMemo(() => presentation?.chapters ?? [], [presentation]);

  const {
    state,
    videoRef,
    play,
    raiseHand,
    submitQuestion,
    appendToken,
    finishAnswer,
    readyForFollowup,
    resume,
    triggerQuiz,
    answerQuiz,
    dismissQuiz,
    enterRecap,
    updateTime,
    reset,
  } = usePresenterState();

  // Host joins the multiplayer room so playback syncs to guests
  const { roomState, sendPlay, sendPause, sendSeek } = useRoomSync(
    id,
    "host",
    videoRef,
  );

  // A/V mesh: acquire local camera + mic, then join PeerJS mesh
  const media = useMediaDevices({ video: true, audio: true });
  const voice = useVoiceRoom(id, media.stream);

  // Voice Pipe: host mixes local + remote audio → STT (active during Q&A phase)
  const voicePipeActive = state.phase === "PAUSED_USER_Q";
  useVoicePipe(id, true, voicePipeActive, media.stream, voice.remoteStreams);

  const [showChapters, setShowChapters] = useState(false);
  const [showParticipants, setShowParticipants] = useState(false);
  const [noteSaved, setNoteSaved] = useState(false);
  const ttsPromptPlayedRef = useRef(false);
  const [showChapterEditor, setShowChapterEditor] = useState(false);
  const [userChapters, setUserChapters] = useState<UserChapter[] | null>(null);
  const [scormExporting, setScormExporting] = useState(false);
  const [questionAttribution, setQuestionAttribution] = useState<{
    askedBy: string;
    question: string;
  } | null>(null);
  const [blackboardActive, setBlackboardActive] = useState(false);

  // Latch blackboard open when any Q&A round begins (local or remote)
  useEffect(() => {
    if (
      state.phase === "PAUSED_USER_Q" ||
      roomState.fsmState === "PAUSED_USER_Q"
    ) {
      setBlackboardActive(true);
    }
  }, [state.phase, roomState.fsmState]);

  const handleInvite = useCallback(async () => {
    try {
      const data = await fetchJson<{ token: string; inviteUrl: string }>(
        `/api/presentations/${id}/invite`,
        { method: "POST" },
      );
      // Use the server-provided inviteUrl which uses the configured
      // presenter.baseUrl (public tunnel domain) — guests are remote
      // and can't reach localhost.
      await navigator.clipboard.writeText(data.inviteUrl);
    } catch (err) {
      console.error("[presenter] Failed to copy invite URL:", err);
    }
  }, [id]);

  const handleLeave = useCallback(async () => {
    // Clear any stale guest cookies before navigating back
    await fetch("/api/invite/logout", { method: "POST" }).catch(() => {});
    router.push("/presenter");
  }, [router]);

  const handleScormExport = useCallback(async () => {
    if (scormExporting) return;
    setScormExporting(true);
    try {
      const resp = await fetch(buildUrl(`/api/presentations/${id}/scorm`), {
        method: "POST",
      });
      if (!resp.ok) throw new Error("Export failed");
      const blob = await resp.blob();
      const disposition = resp.headers.get("content-disposition") ?? "";
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? "presentation-scorm.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[presenter] SCORM export failed:", err);
    } finally {
      setScormExporting(false);
    }
  }, [id, scormExporting]);

  // Sync userChapters from fetched presentation data (first load only)
  const presentationUserChapters = presentation?.user_chapters ?? [];
  const effectiveUserChapters = userChapters ?? presentationUserChapters;

  // Effective chapters: user-defined (if any) or auto-detected
  const effectiveChapters = useMemo(() => {
    if (effectiveUserChapters.length > 0) {
      return effectiveUserChapters.map((uc) => ({
        title: uc.title,
        startSeconds: uc.start_seconds,
        endSeconds: uc.end_seconds,
      }));
    }
    return chapters;
  }, [effectiveUserChapters, chapters]);

  // Play TTS voice prompt when entering Q&A mode (raise hand)
  useEffect(() => {
    if (state.phase !== "PAUSED_USER_Q") {
      ttsPromptPlayedRef.current = false;
      setNoteSaved(false);
      return;
    }
    if (ttsPromptPlayedRef.current) return;
    ttsPromptPlayedRef.current = true;

    // Try server TTS first, fall back to browser SpeechSynthesis
    void (async () => {
      try {
        const resp = await fetch(buildUrl("/api/presentations/tts-prompt"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "Please ask your question out loud.",
            presentationId: id,
          }),
        });
        if (resp.ok) {
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
          await audio.play();
          return;
        }
      } catch {
        /* fall through */
      }
      // Browser fallback
      if ("speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance(
          "Please ask your question out loud.",
        );
        utterance.rate = 0.95;
        speechSynthesis.speak(utterance);
      }
    })();
  }, [state.phase]);

  // Transcribe audio blob via the voice API
  const handleTranscribe = useCallback(
    async (audioBlob: Blob): Promise<string | null> => {
      try {
        const formData = new FormData();
        formData.append("audio", audioBlob, "question.webm");
        const resp = await fetch(buildUrl("/api/voice/transcribe"), {
          method: "POST",
          body: formData,
        });
        if (!resp.ok) return null;
        const data = (await resp.json()) as { text?: string };
        return data.text ?? null;
      } catch {
        return null;
      }
    },
    [],
  );

  // Find current chapter from playback time
  const findChapter = useCallback(
    (time: number) => {
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (time >= chapters[i].startSeconds) return i;
      }
      return 0;
    },
    [chapters],
  );

  // Video time update → check for quiz triggers
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const time = video.currentTime;
    const chIdx = findChapter(time);
    updateTime(time, chIdx);

    // Check for quiz trigger
    if (state.phase !== "PLAYING" || !presentation?.quiz_enabled) return;
    for (const q of quizQuestions) {
      if (
        !state.shownQuizTimestamps.has(q.timestamp_seconds) &&
        time >= q.timestamp_seconds
      ) {
        triggerQuiz(q);
        break;
      }
    }
  }, [
    videoRef,
    findChapter,
    updateTime,
    state.phase,
    state.shownQuizTimestamps,
    presentation?.quiz_enabled,
    quizQuestions,
    triggerQuiz,
  ]);

  // Wire Socket.IO for streaming answers + note save notifications
  useEffect(() => {
    if (!socket) return;

    const handleToken = (data: { token: string }) => appendToken(data.token);
    const handleDone = () => {
      finishAnswer();
      setQuestionAttribution(null);
    };
    const handleNoteSaved = () => setNoteSaved(true);
    const handleError = (data: { error: string }) => {
      appendToken(`\n\n⚠️ Error: ${data.error}`);
      finishAnswer();
      setQuestionAttribution(null);
    };
    const handleStart = (data: { askedBy?: string; question?: string }) => {
      if (data.askedBy && data.question) {
        setQuestionAttribution({
          askedBy: data.askedBy,
          question: data.question,
        });
      }
    };

    socket.on("presenter:answer:start", handleStart);
    socket.on("presenter:answer:token", handleToken);
    socket.on("presenter:answer:done", handleDone);
    socket.on("presenter:answer:error", handleError);
    socket.on("presenter:note:saved", handleNoteSaved);

    return () => {
      socket.off("presenter:answer:start", handleStart);
      socket.off("presenter:answer:token", handleToken);
      socket.off("presenter:answer:done", handleDone);
      socket.off("presenter:answer:error", handleError);
      socket.off("presenter:note:saved", handleNoteSaved);
    };
  }, [socket, appendToken, finishAnswer]);

  // Handle question submission via Socket.IO
  const handleAskQuestion = useCallback(
    (question: string) => {
      submitQuestion(question);
      if (socket) {
        socket.emit("presenter:ask", {
          presentationId: id,
          question,
          chapterIndex: state.currentChapter,
          timestamp: state.currentTime,
        });
      }
    },
    [socket, id, state.currentChapter, state.currentTime, submitQuestion],
  );

  const handleResume = useCallback(() => {
    resume();
    setBlackboardActive(false);
  }, [resume]);

  // Handle video end
  const handleVideoEnd = useCallback(() => {
    enterRecap();
  }, [enterRecap]);

  // Handle host play/pause/seek with room sync
  const handleVideoPlay = useCallback(() => {
    play();
    const video = videoRef.current;
    if (video) sendPlay(video.currentTime);
  }, [play, videoRef, sendPlay]);

  const handleVideoPause = useCallback(() => {
    const video = videoRef.current;
    if (video) sendPause(video.currentTime);
  }, [videoRef, sendPause]);

  const handleVideoSeeked = useCallback(() => {
    const video = videoRef.current;
    if (video) sendSeek(video.currentTime);
  }, [videoRef, sendSeek]);

  // Seek to chapter
  const handleSeekToChapter = useCallback(
    (chapterIndex: number) => {
      const video = videoRef.current;
      if (!video || !chapters[chapterIndex]) return;
      video.currentTime = chapters[chapterIndex].startSeconds;
      if (state.phase === "PLAYING") video.play();
      sendSeek(chapters[chapterIndex].startSeconds);
    },
    [videoRef, chapters, state.phase, sendSeek],
  );

  if (presentationQuery.isLoading) {
    return (
      <main className="flex h-full items-center justify-center bg-zinc-950">
        <p className="text-sm text-white/50">Loading presentation…</p>
      </main>
    );
  }

  if (!presentation) {
    return (
      <main className="flex h-full items-center justify-center bg-zinc-950">
        <p className="text-sm text-white/50">Presentation not found.</p>
      </main>
    );
  }

  if (state.phase === "RECAP") {
    return (
      <RecapScreen
        presentation={presentation}
        quizResults={state.quizResults}
        qaHistory={state.qaHistory}
        onRestart={() => {
          reset();
          const video = videoRef.current;
          if (video) {
            video.currentTime = 0;
            video.play();
          }
        }}
      />
    );
  }

  return (
    <main className="flex flex-1 min-h-0 flex-col overflow-hidden bg-zinc-950">
      {/* ── Top bar (title + metadata) ── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-white/5 bg-zinc-950/90 px-3 py-2 backdrop-blur sm:px-5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-white sm:text-base">
            {presentation.title}
          </h1>
          <p className="truncate text-[10px] text-white/40 sm:text-xs">
            {Math.round(presentation.duration_seconds)}s &middot;{" "}
            {new Date(presentation.created_at).toLocaleDateString()}
            {presentation.quiz_enabled && " · Quizzes enabled"}
          </p>
        </div>
        <button
          onClick={handleScormExport}
          disabled={scormExporting}
          className="rounded-lg bg-white/10 px-3 py-1.5 text-xs text-white/70 transition-colors hover:bg-white/20 disabled:opacity-50"
          title="Export as SCORM 1.2 package"
        >
          {scormExporting ? "Exporting…" : "Export SCORM"}
        </button>
        {roomState.memberCount > 1 && (
          <div className="flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-white/70">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-400" />
            {roomState.memberCount} watching
          </div>
        )}
      </header>

      {/* ── Main content area ── */}
      <div className="relative flex min-h-0 flex-1">
        {/* Video area — fills available space */}
        <div className="relative flex-1 overflow-hidden bg-black">
          <div className="flex h-full w-full items-center justify-center">
            <InteractivePlayer
              videoRef={videoRef}
              videoUrl={buildMediaUrl(
                `/api/files/serve?path=${encodeURIComponent(presentation.video_path)}`,
              )}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleVideoEnd}
              onPlay={handleVideoPlay}
              onPause={handleVideoPause}
              onSeeked={handleVideoSeeked}
            />

            {/* PiP Camera Tile (Teams-style self-view) */}
            <CameraTile
              stream={media.stream}
              isVideoMuted={media.isVideoMuted}
              label="You"
            />

            {/* Remote participant tiles */}
            <RemotePeerTiles
              peerIds={voice.peerIds}
              remoteStreams={voice.remoteStreams}
            />

            {/* Blackboard overlay (Q&A) — latches open until user dismisses */}
            {blackboardActive && (
              <BlackboardOverlay
                question={state.pendingQuestion}
                answerTokens={state.answerTokens}
                isAnswering={
                  state.pendingQuestion !== null && state.answerTokens === ""
                }
                isDone={
                  state.pendingQuestion !== null &&
                  state.answerTokens !== "" &&
                  state.qaHistory.length > 0 &&
                  state.qaHistory[state.qaHistory.length - 1].question ===
                    state.pendingQuestion
                }
                noteSaved={noteSaved}
                onAsk={handleAskQuestion}
                onResume={handleResume}
                onTranscribe={handleTranscribe}
                onFollowUp={readyForFollowup}
                voiceTranscription={voice.transcriptionPreview}
                askedBy={questionAttribution?.askedBy}
                askedQuestion={questionAttribution?.question}
              />
            )}

            {/* Quiz overlay */}
            {state.phase === "PAUSED_AI_QUIZ" && state.activeQuiz && (
              <QuizOverlay
                quiz={state.activeQuiz}
                lastResult={
                  state.quizResults.length > 0
                    ? state.quizResults[state.quizResults.length - 1]
                    : null
                }
                onAnswer={answerQuiz}
                onDismiss={dismissQuiz}
              />
            )}
          </div>
        </div>

        {/* ── Chapter Drawer ── */}
        <SlideDrawer
          open={showChapters}
          onClose={() => setShowChapters(false)}
          title="Chapters"
          side="right"
        >
          <div className="p-3">
            {showChapterEditor && presentation ? (
              <ChapterEditor
                presentationId={presentation.id}
                durationSeconds={presentation.duration_seconds}
                initialChapters={effectiveUserChapters}
                onClose={() => setShowChapterEditor(false)}
                onSaved={(saved) => {
                  setUserChapters(saved);
                  setShowChapterEditor(false);
                }}
              />
            ) : (
              <>
                <ChapterList
                  chapters={effectiveChapters}
                  currentChapter={state.currentChapter}
                  onSeek={handleSeekToChapter}
                />
                <button
                  onClick={() => setShowChapterEditor(true)}
                  className="mt-2 w-full rounded-xl border border-dashed border-white/20 px-3 py-2 text-xs text-white/40 transition-colors hover:border-primary hover:text-primary"
                >
                  {effectiveUserChapters.length > 0
                    ? "Edit chapters"
                    : "+ Define chapters"}
                </button>
              </>
            )}
          </div>
        </SlideDrawer>

        {/* ── Participant Drawer ── */}
        <SlideDrawer
          open={showParticipants}
          onClose={() => setShowParticipants(false)}
          title="Participants"
          side="right"
        >
          <ParticipantPanel
            localStream={media.stream}
            remoteStreams={voice.remoteStreams}
            isAudioMuted={media.isAudioMuted}
            isVideoMuted={media.isVideoMuted}
            memberCount={roomState.memberCount}
            role="host"
          />
        </SlideDrawer>
      </div>

      {/* ── Teams-style Toolbar ── */}
      <PresenterToolbar
        isAudioMuted={media.isAudioMuted}
        isVideoMuted={media.isVideoMuted}
        onToggleAudio={media.toggleAudio}
        onToggleVideo={media.toggleVideo}
        onRaiseHand={raiseHand}
        onToggleParticipants={() => {
          setShowParticipants((v) => !v);
          if (!showParticipants) setShowChapters(false);
        }}
        onToggleChapters={() => {
          setShowChapters((v) => !v);
          if (!showChapters) setShowParticipants(false);
        }}
        onLeave={handleLeave}
        onInvite={handleInvite}
        participantCount={roomState.memberCount}
        showParticipants={showParticipants}
        showChapters={showChapters}
        canRaiseHand={
          state.phase === "PLAYING" && roomState.fsmState !== "PAUSED_USER_Q"
        }
      />

      <ToastContainer />
    </main>
  );
}
