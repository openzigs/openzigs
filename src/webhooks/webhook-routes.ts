import { Router } from "express";
import { logger } from "../logging/logger.js";
import { webhookAuth } from "./webhook-auth.js";
import type { WebhookManager, WebhookConfig } from "./webhook-manager.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { PromptManager } from "../productivity/prompt-manager.js";

export type WebhookRouterOptions = {
  webhookManager: WebhookManager;
  taskEngine?: TaskEngine;
  copilot?: CopilotWrapper;
  promptManager?: PromptManager;
};

/**
 * Creates the public-facing webhook trigger router.
 * Mount at `/api/webhooks/trigger` — this endpoint is where external
 * systems POST to trigger OpenZigs actions.
 */
export const createWebhookRouter = ({ webhookManager, taskEngine, promptManager }: WebhookRouterOptions) => {
  const router = Router();

  /**
   * POST /
   *
   * Authenticated via Bearer token or X-Webhook-Signature + X-Webhook-Id.
   * Body: arbitrary JSON payload passed to the action.
   */
  router.post("/", webhookAuth(webhookManager), async (req, res) => {
    const webhook = (req as unknown as Record<string, unknown>).webhook as WebhookConfig;
    if (!webhook) {
      return res.status(500).json({ error: "Webhook context missing" });
    }

    try {
      webhookManager.recordTrigger(webhook.id);

      if (webhook.action === "prompt" && promptManager) {
        const promptName = typeof webhook.actionPayload.promptName === "string"
          ? webhook.actionPayload.promptName
          : undefined;

        if (!promptName) {
          return res.status(400).json({ error: "Webhook action is 'prompt' but no promptName in actionPayload" });
        }

        // Merge webhook body vars into prompt variables
        const variables = (req.body && typeof req.body === "object") ? req.body : {};
        const resolved = promptManager.resolve(promptName, variables);
        if (resolved === null) {
          return res.status(404).json({ error: `Prompt not found: ${promptName}` });
        }

        // Submit as a task if the task engine is available
        if (taskEngine) {
          const task = taskEngine.submit({
            trigger: "webhook",
            goal: resolved,
            context: `Triggered by webhook "${webhook.name}" (${webhook.id})`,
          }, { mode: "background" });
          logger.info(`Webhook "${webhook.name}" triggered task ${task.id} (prompt: ${promptName})`);
          return res.json({ ok: true, taskId: task.id, prompt: promptName });
        }

        // Fallback: just return the resolved prompt
        return res.json({ ok: true, resolved, prompt: promptName });
      }

      if (webhook.action === "goal") {
        const goal = typeof webhook.actionPayload.goal === "string"
          ? webhook.actionPayload.goal
          : "Execute webhook payload";

        if (taskEngine) {
          const task = taskEngine.submit({
            trigger: "webhook",
            goal,
            context: JSON.stringify(req.body ?? {}),
          }, { mode: "background" });
          logger.info(`Webhook "${webhook.name}" triggered task ${task.id} (goal)`);
          return res.json({ ok: true, taskId: task.id });
        }

        return res.json({ ok: true, goal });
      }

      return res.status(400).json({ error: `Unknown webhook action: ${webhook.action}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Webhook trigger error: ${message}`);
      return res.status(500).json({ error: message });
    }
  });

  return router;
};
