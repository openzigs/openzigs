import { Router } from "express";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { AgentTask, TaskStatus } from "../tasks/types.js";

export type TasksRouterOptions = {
  taskEngine: TaskEngine;
};

export const createTasksRouter = ({ taskEngine }: TasksRouterOptions): Router => {
  const router = Router();

  /** GET /api/tasks — List tasks with optional filters. */
  router.get("/", (req, res) => {
    const status = req.query.status as TaskStatus | undefined;
    const parentTaskId = req.query.parentTaskId as string | undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const tasks = taskEngine.listTasks({ status, limit, parentTaskId });
    res.json({
      tasks: tasks.map(serializeTask),
      count: tasks.length,
    });
  });

  /** GET /api/tasks/stats — Queue statistics. */
  router.get("/stats", (_req, res) => {
    const stats = taskEngine.getStats();
    res.json(stats);
  });

  /** GET /api/tasks/:id — Get a single task. */
  router.get("/:id", (req, res) => {
    const task = taskEngine.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json(serializeTask(task));
  });

  /** GET /api/tasks/:id/children — Children of a task. */
  router.get("/:id/children", (req, res) => {
    const task = taskEngine.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const children = taskEngine.getChildren(req.params.id);
    res.json({
      children: children.map(serializeTask),
      count: children.length,
    });
  });

  /**
   * GET /api/tasks/:id/tree — Full task tree (root + all descendants).
   *
   * Returns React Flow-compatible `nodes` and `edges` arrays for the
   * Visual Workflow Graph component.
   */
  router.get("/:id/tree", (req, res) => {
    const root = taskEngine.getTask(req.params.id);
    if (!root) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const descendants = taskEngine.getDescendants(root.id);
    const allTasks = [root, ...descendants];

    const nodes = allTasks.map((task) => ({
      id: task.id,
      type: "taskNode",
      data: serializeTask(task),
      position: { x: 0, y: 0 }, // Layout is computed client-side by dagre
    }));

    const edges = allTasks
      .filter((task) => task.parentTaskId !== null)
      .map((task) => ({
        id: `e-${task.parentTaskId}-${task.id}`,
        source: task.parentTaskId!,
        target: task.id,
        animated: task.status === "running",
      }));

    res.json({ nodes, edges });
  });

  /** POST /api/tasks/:id/cancel — Cancel a queued or running task. */
  router.post("/:id/cancel", (req, res) => {
    const cancelled = taskEngine.cancel(req.params.id);
    if (!cancelled) {
      res.status(409).json({ error: "Task cannot be cancelled (already completed, failed, or not found)" });
      return;
    }
    res.json(serializeTask(cancelled));
  });

  return router;
};

const serializeTask = (task: AgentTask) => ({
  ...task,
  createdAt: task.createdAt.toISOString(),
  startedAt: task.startedAt?.toISOString() ?? null,
  completedAt: task.completedAt?.toISOString() ?? null,
});
