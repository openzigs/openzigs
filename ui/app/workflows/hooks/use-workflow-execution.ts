import { useCallback, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { useSocket } from "@/lib/socket-context";
import { fetchJson } from "@/lib/api";

interface StageInput {
  type: string;
  name: string;
  prompt?: string;
  tools?: string[] | null;
  model?: string;
}

type Status = "idle" | "running" | "done" | "error";

/**
 * Manages workflow execution via the task API and Socket.IO status events.
 * Updates node data with executionStatus for visual feedback on the canvas.
 */
export function useWorkflowExecution(
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>,
) {
  const [executionStatus, setExecutionStatus] = useState<Status>("idle");
  const taskIdRef = useRef<string | null>(null);
  const { socket } = useSocket();

  const clearNodeStatuses = useCallback(() => {
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: { ...n.data, executionStatus: undefined },
      })),
    );
  }, [setNodes]);

  const runWorkflow = useCallback(
    async (stages: StageInput[], name: string) => {
      if (stages.length === 0) return;
      clearNodeStatuses();
      setExecutionStatus("running");

      // Mark all prompt nodes as pending
      setNodes((nds) =>
        nds.map((n) =>
          n.type === "promptStage"
            ? { ...n, data: { ...n.data, executionStatus: "pending" } }
            : n,
        ),
      );

      try {
        const res = await fetchJson<{ task?: { id: string } }>("/api/admin/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: name,
            description: `Workflow execution: ${name}`,
            stages,
          }),
        });

        const taskId = res?.task?.id;
        if (!taskId) {
          setExecutionStatus("error");
          return;
        }

        taskIdRef.current = taskId;

        // Listen for task progress via Socket.IO
        if (socket) {
          const handleStageProgress = (data: { taskId: string; stageName: string; status: string }) => {
            if (data.taskId !== taskId) return;
            setNodes((nds) =>
              nds.map((n) =>
                n.type === "promptStage" && String(n.data.name) === data.stageName
                  ? { ...n, data: { ...n.data, executionStatus: data.status } }
                  : n,
              ),
            );
          };

          const handleTaskComplete = (data: { taskId: string; status: string }) => {
            if (data.taskId !== taskId) return;
            setExecutionStatus(data.status === "completed" ? "done" : "error");
            socket.off("task:stage-progress", handleStageProgress);
            socket.off("task:completed", handleTaskComplete);
          };

          socket.on("task:stage-progress", handleStageProgress);
          socket.on("task:completed", handleTaskComplete);
        }
      } catch {
        setExecutionStatus("error");
      }
    },
    [socket, setNodes, clearNodeStatuses],
  );

  const stopWorkflow = useCallback(async () => {
    if (!taskIdRef.current) return;
    try {
      await fetchJson(`/api/admin/tasks/${taskIdRef.current}/cancel`, { method: "POST" });
    } catch {
      // best-effort
    }
    setExecutionStatus("idle");
    clearNodeStatuses();
    taskIdRef.current = null;
  }, [clearNodeStatuses]);

  return {
    executionStatus,
    runWorkflow,
    stopWorkflow,
    isRunning: executionStatus === "running",
  };
}
