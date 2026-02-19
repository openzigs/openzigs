"use client";

import { useEffect, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, buildUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { usePresenterState } from "@/hooks/use-presenter-state";
import type { QuizQuestion } from "@/hooks/use-presenter-state";
import { InteractivePlayer } from "@/components/presenter/interactive-player";
import { ChapterList } from "@/components/presenter/chapter-list";
import { RaiseHandButton } from "@/components/presenter/raise-hand-button";
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

export default function PresenterPlayerPage() {
  const { id } = useParams<{ id: string }>();
  const { socket } = useSocket();

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
        time >= q.timestamp_seconds &&
        time < q.timestamp_seconds + 1
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

  // Wire Socket.IO for streaming answers
  useEffect(() => {
    if (!socket) return;

    const handleToken = (data: { token: string }) => appendToken(data.token);
    const handleDone = () => finishAnswer();

    socket.on("presenter:answer:token", handleToken);
    socket.on("presenter:answer:done", handleDone);

    return () => {
      socket.off("presenter:answer:token", handleToken);
      socket.off("presenter:answer:done", handleDone);
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

  // Handle video end
  const handleVideoEnd = useCallback(() => {
    enterRecap();
  }, [enterRecap]);

  // Seek to chapter
  const handleSeekToChapter = useCallback(
    (chapterIndex: number) => {
      const video = videoRef.current;
      if (!video || !chapters[chapterIndex]) return;
      video.currentTime = chapters[chapterIndex].startSeconds;
      if (state.phase === "PLAYING") video.play();
    },
    [videoRef, chapters, state.phase],
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
      <div className="relative flex-1">
        <InteractivePlayer
          videoRef={videoRef}
          videoUrl={buildUrl(`/api/files/serve?path=${encodeURIComponent(presentation.video_path)}`)}
          onTimeUpdate={handleTimeUpdate}
          onEnded={handleVideoEnd}
          onPlay={play}
        />

        {/* Raise Hand button */}
        {state.phase === "PLAYING" && (
          <RaiseHandButton onClick={raiseHand} />
        )}

        {/* Blackboard overlay (Q&A) */}
        {state.phase === "PAUSED_USER_Q" && (
          <BlackboardOverlay
            question={state.pendingQuestion}
            answerTokens={state.answerTokens}
            isAnswering={state.pendingQuestion !== null && state.answerTokens === ""}
            isDone={state.pendingQuestion !== null && state.answerTokens !== "" && state.qaHistory.length > 0 && state.qaHistory[state.qaHistory.length - 1].question === state.pendingQuestion}
            onAsk={handleAskQuestion}
            onResume={resume}
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

        <h1 className="mt-3 text-lg font-semibold text-foreground">
          {presentation.title}
        </h1>
        <p className="text-xs text-muted-foreground">
          {Math.round(presentation.duration_seconds)}s &middot;{" "}
          {new Date(presentation.created_at).toLocaleDateString()}
          {presentation.quiz_enabled && " · Quizzes enabled"}
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
