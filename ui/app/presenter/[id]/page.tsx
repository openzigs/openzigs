"use client";

import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, buildUrl } from "@/lib/api";
import { useSocket } from "@/lib/socket-context";
import { usePresenterState } from "@/hooks/use-presenter-state";
import type { QuizQuestion } from "@/hooks/use-presenter-state";
import { InteractivePlayer } from "@/components/presenter/interactive-player";
import { ChapterList } from "@/components/presenter/chapter-list";
import { ChapterEditor } from "@/components/presenter/chapter-editor";
import type { UserChapter } from "@/components/presenter/chapter-editor";
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
  user_chapters: UserChapter[];
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

  const [noteSaved, setNoteSaved] = useState(false);
  const ttsPromptPlayedRef = useRef(false);
  const [showChapterEditor, setShowChapterEditor] = useState(false);
  const [userChapters, setUserChapters] = useState<UserChapter[] | null>(null);

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
        const resp = await fetch(
          buildUrl("/api/presentations/tts-prompt"),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: "Please ask your question out loud.",
              presentationId: id,
            }),
          },
        );
        if (resp.ok) {
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = () => URL.revokeObjectURL(url);
          await audio.play();
          return;
        }
      } catch { /* fall through */ }
      // Browser fallback
      if ("speechSynthesis" in window) {
        const utterance = new SpeechSynthesisUtterance("Please ask your question out loud.");
        utterance.rate = 0.95;
        speechSynthesis.speak(utterance);
      }
    })();
  }, [state.phase]);

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
    const handleDone = () => finishAnswer();
    const handleNoteSaved = () => setNoteSaved(true);

    socket.on("presenter:answer:token", handleToken);
    socket.on("presenter:answer:done", handleDone);
    socket.on("presenter:note:saved", handleNoteSaved);

    return () => {
      socket.off("presenter:answer:token", handleToken);
      socket.off("presenter:answer:done", handleDone);
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
      <div className="flex-1">
        <div className="relative">
          <InteractivePlayer
            videoRef={videoRef}
            videoUrl={`/api/files/serve?path=${encodeURIComponent(presentation.video_path)}`}
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
              noteSaved={noteSaved}
              onAsk={handleAskQuestion}
              onResume={resume}
              onTranscribe={handleTranscribe}
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
        </p>
      </div>

      {/* Sidebar — chapters */}
      <aside className="w-full shrink-0 lg:w-64">
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
              className="mt-2 w-full rounded-xl border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:border-primary hover:text-primary transition-colors"
            >
              {effectiveUserChapters.length > 0
                ? "Edit chapters"
                : "+ Define chapters"}
            </button>
          </>
        )}
      </aside>

      <ToastContainer />
    </main>
  );
}
