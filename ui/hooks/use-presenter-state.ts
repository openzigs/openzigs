"use client";

import { useReducer, useCallback, useRef } from "react";

/**
 * Presenter Mode FSM — Issue #277 (SI-2)
 *
 * States: PLAYING → PAUSED_USER_Q (Raise Hand) → PAUSED_AI_QUIZ (Pop Quiz) → RECAP (video end)
 * All transitions are explicit and type-safe via useReducer.
 */

export type PresenterPhase =
  | "PLAYING"
  | "PAUSED_USER_Q"
  | "PAUSED_AI_QUIZ"
  | "RECAP";

export interface QuizQuestion {
  id: string;
  chapter_index: number;
  timestamp_seconds: number;
  question: string;
  options: string[];
  correct_index: number;
  explanation: string;
}

export interface QAEntry {
  question: string;
  answer: string;
  timestamp: number;
  chapterIndex: number;
}

export interface QuizResult {
  questionId: string;
  question: string;
  selectedIndex: number;
  correctIndex: number;
  correct: boolean;
  explanation: string;
}

export interface PresenterState {
  phase: PresenterPhase;
  currentTime: number;
  currentChapter: number;
  /** Active question from user (Raise Hand) */
  pendingQuestion: string | null;
  /** Streaming answer tokens */
  answerTokens: string;
  /** Pop quiz being displayed */
  activeQuiz: QuizQuestion | null;
  /** Results from quizzes taken */
  quizResults: QuizResult[];
  /** Q&A transcript */
  qaHistory: QAEntry[];
  /** Set of quiz timestamps already shown */
  shownQuizTimestamps: Set<number>;
}

type PresenterAction =
  | { type: "PLAY" }
  | { type: "TIME_UPDATE"; time: number; chapterIndex: number }
  | { type: "RAISE_HAND" }
  | { type: "SUBMIT_QUESTION"; question: string }
  | { type: "ANSWER_TOKEN"; token: string }
  | { type: "ANSWER_DONE" }
  | { type: "TRIGGER_QUIZ"; quiz: QuizQuestion }
  | { type: "ANSWER_QUIZ"; selectedIndex: number }
  | { type: "DISMISS_QUIZ" }
  | { type: "ENTER_RECAP" }
  | { type: "RESUME" }
  | { type: "RESET" };

function presenterReducer(
  state: PresenterState,
  action: PresenterAction,
): PresenterState {
  switch (action.type) {
    case "PLAY":
      return { ...state, phase: "PLAYING" };

    case "TIME_UPDATE":
      return {
        ...state,
        currentTime: action.time,
        currentChapter: action.chapterIndex,
      };

    case "RAISE_HAND":
      return {
        ...state,
        phase: "PAUSED_USER_Q",
        pendingQuestion: null,
        answerTokens: "",
      };

    case "SUBMIT_QUESTION":
      return { ...state, pendingQuestion: action.question };

    case "ANSWER_TOKEN":
      return { ...state, answerTokens: state.answerTokens + action.token };

    case "ANSWER_DONE": {
      const entry: QAEntry = {
        question: state.pendingQuestion ?? "",
        answer: state.answerTokens,
        timestamp: state.currentTime,
        chapterIndex: state.currentChapter,
      };
      return {
        ...state,
        qaHistory: [...state.qaHistory, entry],
      };
    }

    case "TRIGGER_QUIZ": {
      const newShown = new Set(state.shownQuizTimestamps);
      newShown.add(action.quiz.timestamp_seconds);
      return {
        ...state,
        phase: "PAUSED_AI_QUIZ",
        activeQuiz: action.quiz,
        shownQuizTimestamps: newShown,
      };
    }

    case "ANSWER_QUIZ": {
      if (!state.activeQuiz) return state;
      const result: QuizResult = {
        questionId: state.activeQuiz.id,
        question: state.activeQuiz.question,
        selectedIndex: action.selectedIndex,
        correctIndex: state.activeQuiz.correct_index,
        correct: action.selectedIndex === state.activeQuiz.correct_index,
        explanation: state.activeQuiz.explanation,
      };
      return {
        ...state,
        quizResults: [...state.quizResults, result],
      };
    }

    case "DISMISS_QUIZ":
      return { ...state, phase: "PLAYING", activeQuiz: null };

    case "ENTER_RECAP":
      return { ...state, phase: "RECAP" };

    case "RESUME":
      return {
        ...state,
        phase: "PLAYING",
        pendingQuestion: null,
        answerTokens: "",
      };

    case "RESET":
      return createInitialPresenterState();

    default:
      return state;
  }
}

function createInitialPresenterState(): PresenterState {
  return {
    phase: "PLAYING",
    currentTime: 0,
    currentChapter: 0,
    pendingQuestion: null,
    answerTokens: "",
    activeQuiz: null,
    quizResults: [],
    qaHistory: [],
    shownQuizTimestamps: new Set(),
  };
}

export function usePresenterState() {
  const [state, dispatch] = useReducer(
    presenterReducer,
    undefined,
    createInitialPresenterState,
  );
  const videoRef = useRef<HTMLVideoElement>(null!);

  const play = useCallback(() => {
    dispatch({ type: "PLAY" });
    videoRef.current?.play();
  }, []);

  const raiseHand = useCallback(() => {
    videoRef.current?.pause();
    dispatch({ type: "RAISE_HAND" });
  }, []);

  const submitQuestion = useCallback((question: string) => {
    dispatch({ type: "SUBMIT_QUESTION", question });
  }, []);

  const appendToken = useCallback((token: string) => {
    dispatch({ type: "ANSWER_TOKEN", token });
  }, []);

  const finishAnswer = useCallback(() => {
    dispatch({ type: "ANSWER_DONE" });
  }, []);

  const resume = useCallback(() => {
    dispatch({ type: "RESUME" });
    videoRef.current?.play();
  }, []);

  const triggerQuiz = useCallback((quiz: QuizQuestion) => {
    videoRef.current?.pause();
    dispatch({ type: "TRIGGER_QUIZ", quiz });
  }, []);

  const answerQuiz = useCallback((selectedIndex: number) => {
    dispatch({ type: "ANSWER_QUIZ", selectedIndex });
  }, []);

  const dismissQuiz = useCallback(() => {
    dispatch({ type: "DISMISS_QUIZ" });
    videoRef.current?.play();
  }, []);

  const enterRecap = useCallback(() => {
    dispatch({ type: "ENTER_RECAP" });
  }, []);

  const updateTime = useCallback((time: number, chapterIndex: number) => {
    dispatch({ type: "TIME_UPDATE", time, chapterIndex });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return {
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
  };
}
