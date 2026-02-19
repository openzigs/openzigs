"use client";

import { useEffect, useCallback, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Mic } from "lucide-react";
import { fetchJson, buildUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { usePresenterState } from "@/hooks/use-presenter-state";
import { useRoomSync } from "@/hooks/useRoomSync";
import type { RoomRole } from "@/hooks/useRoomSync";
import { useVoiceRoom } from "@/hooks/useVoiceRoom";
import type { PushToTalkState } from "@/components/presenter/push-to-talk-button";
import type { QuizQuestion } from "@/hooks/use-presenter-state";
import { InteractivePlayer } from "@/components/presenter/interactive-player";
import { ChapterList } from "@/components/presenter/chapter-list";
import { PushToTalkButton } from "@/components/presenter/push-to-talk-button";
import { QuizOverlay } from "@/components/presenter/quiz-overlay";
import { BlackboardOverlay } from "@/components/presenter/blackboard-overlay";
import { RecapScreen } from "@/components/presenter/recap-screen";
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
  voice_id: string | null;
  quiz_enabled: boolean;
  quiz_config: { timestamps: number[]; difficulty: string } | null;
  mode: string;
  created_at: string;
}

export default function RoomPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const { socket } = useSocket();

  // Determine role: host if ?role=host, else guest (default for invite links)
  const role: RoomRole = (searchParams.get("role") === "host" ? "host" : "guest");

  const presentationQuery = useQuery({
    queryKey: ["presentation", id],
    queryFn: () => fetchJson<PresentationDetail>(`/api/presentations/${id}`),
    enabled: !!id,
  });

  const quizQuery = useQuery({
    queryKey: ["presentation-quiz", id],
    queryFn: () =>
      fetchJson<{ questions: QuizQuestion[] }>(
        `/api/presentations/${id}/quiz`,
      ),
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
    resume,
    triggerQuiz,
    answerQuiz,
    dismissQuiz,
    enterRecap,
    updateTime,
    reset,
  } = usePresenterState();

  const { roomState, sendPlay, sendPause, sendSeek } = useRoomSync(id, role, videoRef);
  const voice = useVoiceRoom(id);

  // Derive Push-to-Talk button state
  const pttState: PushToTalkState = voice.isTranscribing
    ? "transcribing"
    : voice.isRaisingHand
      ? "raised"
      : "idle";

  const [noteSaved, setNoteSaved] = useState(false);
  const [questionAttribution, setQuestionAttribution] = useState<{
    askedBy: string;
    question: string;
  } | null>(null);

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

  // Wire Socket.IO for streaming answers + note save notifications + attribution
  useEffect(() => {
    if (!socket) return;

    const handleStart = (data: { askedBy?: string; question?: string }) => {
      if (data.askedBy && data.question) {
        setQuestionAttribution({ askedBy: data.askedBy, question: data.question });
      }
    };
    const handleToken = (data: { token: string }) => appendToken(data.token);
    const handleDone = () => {
      finishAnswer();
      setQuestionAttribution(null);
    };
    const handleNoteSaved = () => setNoteSaved(true);

    socket.on("presenter:answer:start", handleStart);
    socket.on("presenter:answer:token", handleToken);
    socket.on("presenter:answer:done", handleDone);
    socket.on("presenter:note:saved", handleNoteSaved);

    return () => {
      socket.off("presenter:answer:start", handleStart);
      socket.off("presenter:answer:token", handleToken);
      socket.off("presenter:answer:done", handleDone);
      socket.off("presenter:note:saved", handleNoteSaved);
    };
  }, [socket, appendToken, finishAnswer]);

  // Open blackboard when room FSM transitions to PAUSED_USER_Q
  const showBlackboard = state.phase === "PAUSED_USER_Q" || roomState.fsmState === "PAUSED_USER_Q";

  // Handle host play/pause/seek with room sync
  const handleVideoPlay = useCallback(() => {
    play();
    if (role === "host") {
      const video = videoRef.current;
      if (video) sendPlay(video.currentTime);
    }
  }, [play, role, videoRef, sendPlay]);

  const handleVideoPause = useCallback(() => {
    if (role === "host") {
      const video = videoRef.current;
      if (video) sendPause(video.currentTime);
    }
  }, [role, videoRef, sendPause]);

  const handleVideoSeeked = useCallback(() => {
    if (role === "host") {
      const video = videoRef.current;
      if (video) sendSeek(video.currentTime);
    }
  }, [role, videoRef, sendSeek]);

  // Transcribe audio blob via the voice API
  const handleTranscribe = useCallback(async (audioBlob: Blob): Promise<string | null> => {
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "question.webm");
      const resp = await fetch(buildUrl("/api/voice/transcribe"), {
        method: "POST",
        body: formData,
      });
      if (!resp.ok) return null;
      const data = await resp.json() as { text?: string };
      return data.text ?? null;
    } catch {
      return null;
    }
  }, []);

  // Handle question submission
  const handleAskQuestion = useCallback(
    (question: string) => {
      submitQuestion(question);
      raiseHand();
      if (socket) {
        socket.emit("presenter:ask", {
          presentationId: id,
          question,
          chapterIndex: state.currentChapter,
          timestamp: state.currentTime,
        });
      }
    },
    [socket, id, state.currentChapter, state.currentTime, submitQuestion, raiseHand],
  );

  const handleVideoEnd = useCallback(() => {
    enterRecap();
  }, [enterRecap]);

  const handleSeekToChapter = useCallback(
    (chapterIndex: number) => {
      const video = videoRef.current;
      if (!video || !chapters[chapterIndex]) return;
      video.currentTime = chapters[chapterIndex].startSeconds;
      if (state.phase === "PLAYING") video.play();
      if (role === "host") sendSeek(chapters[chapterIndex].startSeconds);
    },
    [videoRef, chapters, state.phase, role, sendSeek],
  );

  if (presentationQuery.isLoading) {
    return (
      <main className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading presentation…</p>
      </main>
    );
  }

  if (!presentation) {
    return (
      <main className="flex h-[calc(100vh-4rem)] items-center justify-center">
        <p className="text-sm text-muted-foreground">Presentation not found.</p>
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
    <main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 lg:flex-row lg:px-8">
      {/* Video + overlays */}
      <div className="flex-1">
        <div className="relative">
          <InteractivePlayer
            videoRef={videoRef}
            videoUrl={`/api/files/serve?path=${encodeURIComponent(presentation.video_path)}`}
            onTimeUpdate={handleTimeUpdate}
            onEnded={handleVideoEnd}
            onPlay={handleVideoPlay}
            onPause={handleVideoPause}
            onSeeked={handleVideoSeeked}
          />

          {/* Member count pill */}
          <div className="absolute right-3 top-3 flex items-center gap-3">
            <div className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs text-white backdrop-blur">
              <span className="inline-block h-2 w-2 rounded-full bg-green-400" />
              {roomState.memberCount} watching
            </div>
            {voice.peers.length > 0 && (
              <div className="flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1 text-xs text-white backdrop-blur">
                <Mic className="h-3 w-3" />
                {voice.peers.length} on voice
              </div>
            )}
          </div>

          {/* Push-to-Talk button (replaces RaiseHand in voice rooms) */}
          {(state.phase === "PLAYING" || roomState.fsmState === "PLAYING") && (
            <PushToTalkButton
              state={pttState}
              onRaiseHand={voice.raiseHand}
              onLowerHand={voice.lowerHand}
              transcriptionPreview={voice.transcriptionPreview}
            />
          )}

          {/* Blackboard overlay (Q&A) — opens for all when any participant asks */}
          {showBlackboard && (
            <BlackboardOverlay
              question={state.pendingQuestion}
              answerTokens={state.answerTokens}
              isAnswering={state.pendingQuestion !== null && state.answerTokens === ""}
              isDone={
                state.pendingQuestion !== null &&
                state.answerTokens !== "" &&
                state.qaHistory.length > 0 &&
                state.qaHistory[state.qaHistory.length - 1].question === state.pendingQuestion
              }
              noteSaved={noteSaved}
              onAsk={handleAskQuestion}
              onResume={resume}
              onTranscribe={handleTranscribe}
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

        <h1 className="mt-3 text-lg font-semibold text-foreground">
          {presentation.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {Math.round(presentation.duration_seconds)}s &middot;{" "}
          {new Date(presentation.created_at).toLocaleDateString()}
          {presentation.quiz_enabled && " · Quizzes enabled"}
          {" · "}
          <span className="capitalize">{role}</span>
        </p>
      </div>

      {/* Sidebar — chapters */}
      <aside className="w-full shrink-0 lg:w-64">
        <ChapterList
          chapters={chapters}
          currentChapter={state.currentChapter}
          onSeek={handleSeekToChapter}
        />
      </aside>

      <ToastContainer />
    </main>
  );
}
