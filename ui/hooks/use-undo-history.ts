"use client";

import { useState, useCallback, useRef } from "react";

/**
 * Undo/redo history hook for timeline editing.
 * Stores snapshots of manifest state using the command pattern.
 * #824 — Enhanced Timeline Editor
 */
export function useUndoHistory<T>(initial: T, maxHistory = 20) {
  const [state, setState] = useState<T>(initial);
  const undoStack = useRef<T[]>([]);
  const redoStack = useRef<T[]>([]);

  const push = useCallback(
    (next: T) => {
      undoStack.current = [
        ...undoStack.current.slice(-(maxHistory - 1)),
        state,
      ];
      redoStack.current = [];
      setState(next);
    },
    [state, maxHistory],
  );

  const undo = useCallback(() => {
    if (undoStack.current.length === 0) return;
    const prev = undoStack.current[undoStack.current.length - 1];
    undoStack.current = undoStack.current.slice(0, -1);
    redoStack.current = [...redoStack.current, state];
    setState(prev);
  }, [state]);

  const redo = useCallback(() => {
    if (redoStack.current.length === 0) return;
    const next = redoStack.current[redoStack.current.length - 1];
    redoStack.current = redoStack.current.slice(0, -1);
    undoStack.current = [...undoStack.current, state];
    setState(next);
  }, [state]);

  const reset = useCallback((next: T) => {
    undoStack.current = [];
    redoStack.current = [];
    setState(next);
  }, []);

  return {
    state,
    push,
    undo,
    redo,
    reset,
    canUndo: undoStack.current.length > 0,
    canRedo: redoStack.current.length > 0,
  };
}
