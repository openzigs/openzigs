import { Router } from "express";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { TaskRepository } from "../tasks/task-repository.js";
import type { AgentTask, TaskStatus } from "../tasks/types.js";

export type TasksRouterOptions = {
  taskEngine: TaskEngine;
  taskRepository?: TaskRepository;
};

export const createTasksRouter = ({ taskEngine, taskRepository }: TasksRouterOptions): Router => {
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

  /** GET /api/tasks/roots — All root tasks (no parent) with child count. */
  router.get("/roots", (req, res) => {
    if (!taskRepository) {
      res.status(501).json({ error: "Task repository not available" });
      return;
    }
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const roots = taskRepository.getRootTasks({ limit, offset });
    res.json({ roots, count: roots.length });
  });

  /** GET /api/tasks/usage/summary — Aggregate token usage across recent tasks. */
  router.get("/usage/summary", (req, res) => {
    const hours = req.query.hours ? Number(req.query.hours) : 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    let tasks: AgentTask[];
    if (taskRepository) {
      tasks = taskRepository.listSince(since, { limit: 500 });
    } else {
      tasks = taskEngine.listTasks({ limit: 500 });
    }

    let totalInput = 0;
    let totalOutput = 0;
    let totalTokens = 0;
    let taskCount = 0;

    for (const task of tasks) {
      if (task.tokenUsage) {
        totalInput += task.tokenUsage.inputTokens;
        totalOutput += task.tokenUsage.outputTokens;
        totalTokens += task.tokenUsage.totalTokens;
        taskCount++;
      }
    }

    res.json({
      hours,
      taskCount,
      totalInput,
      totalOutput,
      totalTokens,
    });
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
   * GET /api/tasks/:id/tree — Full task tree from root to all descendants.
   *
   * Always walks UP to the root of the tree first, then returns the full
   * hierarchy regardless of which node the user clicked — this ensures the
   * orchestration graph always shows the complete workflow.
   *
   * Supports `?maxDepth=N` (default 10) and `?format=graph` for React Flow nodes/edges.
   * Default format returns nested TaskTreeNode with aggregate stats.
   */
  router.get("/:id/tree", (req, res) => {
    const task = taskEngine.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Walk up to the root of the tree
    const root = taskEngine.getRoot(req.params.id);
    const rawDepth = Number(req.query.maxDepth);
    const maxDepth = Number.isFinite(rawDepth) ? Math.max(1, Math.min(rawDepth, 50)) : 10;
    const format = typeof req.query.format === "string" ? req.query.format : undefined;

    // If repository is available, use efficient recursive CTE
    if (taskRepository && format !== "graph") {
      const tree = taskRepository.getTaskTree(root.id, maxDepth);
      if (!tree) {
        res.status(404).json({ error: "Task tree not found" });
        return;
      }
      res.json(tree);
      return;
    }

    // Fallback: in-memory traversal for React Flow graph format
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

  /** GET /api/tasks/:id/usage — Token usage for a single task. */
  router.get("/:id/usage", (req, res) => {
    const task = taskEngine.getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.json({ taskId: task.id, tokenUsage: task.tokenUsage ?? null });
  });

  return router;
};

const serializeTask = (task: AgentTask) => ({
  ...task,
  createdAt: task.createdAt.toISOString(),
  startedAt: task.startedAt?.toISOString() ?? null,
  completedAt: task.completedAt?.toISOString() ?? null,
});
