import type { TaskEngine } from "./task-engine.js";
import type { AgentTask } from "./types.js";

const isTerminal = (status: string): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

/**
 * Wait for a specific task to reach a terminal state (completed, failed, cancelled).
 *
 * Uses a listener + re-check pattern to avoid race conditions:
 * 1. Check if already completed
 * 2. Attach listeners
 * 3. Re-check (task may have completed between step 1 and 2)
 */
export const waitForTask = (
  engine: TaskEngine,
  taskId: string,
  signal: AbortSignal
): Promise<AgentTask> => {
  // Fast path: already in terminal state
  const existing = engine.getTask(taskId);
  if (existing && isTerminal(existing.status)) {
    return Promise.resolve(existing);
  }

  return new Promise<AgentTask>((resolve, reject) => {
    const onComplete = (task: AgentTask) => {
      if (task.id === taskId) {
        cleanup();
        resolve(task);
      }
    };
    const onFail = (task: AgentTask) => {
      if (task.id === taskId) {
        cleanup();
        resolve(task); // Resolve (not reject) — caller handles failure
      }
    };
    const onCancel = (task: AgentTask) => {
      if (task.id === taskId) {
        cleanup();
        resolve(task);
      }
    };
    const onAbort = () => {
      cleanup();
      reject(new Error(`Timeout waiting for task ${taskId}`));
    };

    const cleanup = () => {
      engine.off("task:completed", onComplete);
      engine.off("task:failed", onFail);
      engine.off("task:cancelled", onCancel);
      signal.removeEventListener("abort", onAbort);
    };

    engine.on("task:completed", onComplete);
    engine.on("task:failed", onFail);
    engine.on("task:cancelled", onCancel);
    signal.addEventListener("abort", onAbort, { once: true });

    // Re-check after attaching listeners (race condition guard)
    const recheck = engine.getTask(taskId);
    if (recheck && isTerminal(recheck.status)) {
      cleanup();
      resolve(recheck);
    }
  });
};
