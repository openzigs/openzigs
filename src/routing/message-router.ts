import type { ChannelManager } from "../channels/channel-manager.js";
import type { IncomingMessage, MessageContent } from "../channels/types.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { ToolRegistry } from "../mcp/tool-registry.js";
import type { AccessControlConfig } from "../config/index.js";
import type { ConversationEvent, SessionManager } from "../sessions/session-manager.js";
import type { PersonalityManager } from "../personality/personality-manager.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import { ALWAYS_ON_TOOLS } from "../mcp/constants.js";
import { setActiveChatContext, clearActiveChatContext } from "../mcp/tools/agent-tools.js";
import { setActiveOrchestrateContext, clearActiveOrchestrateContext } from "../mcp/tools/orchestrate-agents.js";

export type RouteOptions = {
  /** Callback invoked for each streaming chunk. */
  onChunk?: (chunk: string) => void;
  /** Override the model for this request. */
  model?: string;
  /** Callback invoked when a tool is called during processing. */
  onToolCall?: (tool: string, args: unknown) => void;
  /** Optional tool allowlist for this request. Only these tools (+ ALWAYS_ON_TOOLS) will be available. */
  allowedTools?: string[];
};

export type MessageRouterOptions = {
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  copilot: CopilotWrapper;
  /** Tool registry, needed to resolve per-request tool scoping. */
  toolRegistry?: ToolRegistry;
  accessControl?: AccessControlConfig;
  historyLimit?: number;
  maxToolsPerRequest?: number;
  clock?: () => Date;
  personalityManager?: PersonalityManager;
  /** When provided, chat messages are tracked as TaskEngine tasks. */
  taskEngine?: TaskEngine;
};

const defaultAccessControl: AccessControlConfig = {
  mode: "open",
  allowedUsers: [],
  blockedUsers: []
};

export { ALWAYS_ON_TOOLS };

export class MessageRouter {
  private channelManager: ChannelManager;
  private sessionManager: SessionManager;
  private copilot: CopilotWrapper;
  private toolRegistry?: ToolRegistry;
  private userSessions = new Map<string, string>();
  private accessControl: AccessControlConfig;
  private historyLimit: number;
  public readonly maxToolsPerRequest: number;
  private clock: () => Date;
  private personalityManager?: PersonalityManager;
  private taskEngine?: TaskEngine;

  constructor({
    channelManager,
    sessionManager,
    copilot,
    toolRegistry,
    accessControl,
    historyLimit = 20,
    maxToolsPerRequest = 30,
    clock,
    personalityManager,
    taskEngine
  }: MessageRouterOptions) {
    this.channelManager = channelManager;
    this.sessionManager = sessionManager;
    this.copilot = copilot;
    this.toolRegistry = toolRegistry;
    this.accessControl = accessControl ?? defaultAccessControl;
    this.historyLimit = historyLimit;
    this.maxToolsPerRequest = maxToolsPerRequest;
    this.clock = clock ?? (() => new Date());
    this.personalityManager = personalityManager;
    this.taskEngine = taskEngine;
  }

  /** Invalidate the cached session for a user so the next message creates a new session. */
  clearUserSession(channelType: string, userId: string): void {
    const key = this.keyFor(channelType, userId);
    this.userSessions.delete(key);
  }

  async route(message: IncomingMessage, options?: RouteOptions): Promise<void> {
    const channel = this.channelManager.getChannel(message.channelType);
    if (!channel) {
      throw new Error(`Channel not registered: ${message.channelType}`);
    }

    if (!this.isAllowed(message)) {
      await channel.sendMessage(message.chatId, { text: "Unauthorized" });
      return;
    }

    const sessionId = await this.getOrCreateSessionId(message);

    // Create a tracked task when TaskEngine is available
    let taskId: string | undefined;
    if (this.taskEngine) {
      try {
        const task = this.taskEngine.submit(
          {
            trigger: "chat",
            goal: message.content.slice(0, 200),
            sessionId,
            channelType: message.channelType,
            chatId: message.chatId,
            model: options?.model,
            notifyOnComplete: false, // Chat messages are delivered inline
          },
          { mode: "immediate" }
        );
        taskId = task.id;
      } catch {
        // Rate limit or other task submission failure — proceed without tracking
      }
    }

    const resume = await this.sessionManager.resumeSession(sessionId, this.historyLimit);
    const prompt = this.buildPrompt(resume.history, message.content);

    let response = "";
    try {
      // Set chat context so spawn-agent and orchestrate-agents can propagate originating session/channel info
      setActiveChatContext({
        sessionId,
        channelType: message.channelType as import("../channels/types.js").ChannelType,
        chatId: message.chatId,
        parentTaskId: taskId,
      });
      setActiveOrchestrateContext({
        sessionId,
        channelType: message.channelType as import("../channels/types.js").ChannelType,
        chatId: message.chatId,
        parentTaskId: taskId,
      });

      // Resolve per-request tool scoping if the caller provided an allowedTools list
      const scopedTools = this.resolveScopedTools(options?.allowedTools);

      for await (const chunk of this.copilot.chat(prompt, { model: options?.model, tools: scopedTools, onToolCall: options?.onToolCall })) {
        response += chunk;
        if (options?.onChunk) {
          options.onChunk(chunk);
        }
      }

      clearActiveChatContext();
      clearActiveOrchestrateContext();

      // Mark task completed
      if (taskId && this.taskEngine) {
        this.taskEngine.complete(taskId, response.slice(0, 500));
      }
    } catch (error) {
      clearActiveChatContext();
      clearActiveOrchestrateContext();
      // Mark task failed
      if (taskId && this.taskEngine) {
        const msg = error instanceof Error ? error.message : String(error);
        this.taskEngine.fail(taskId, msg);
      }
      throw error;
    }

    const now = this.clock();
    await this.sessionManager.appendEvent(sessionId, {
      timestamp: message.timestamp,
      type: "user",
      content: message.content
    });

    await this.sessionManager.appendEvent(sessionId, {
      timestamp: now,
      type: "assistant",
      content: response
    });

    // When streaming via onChunk, the channel handler manages delivery;
    // only send the full message when not streaming.
    if (!options?.onChunk) {
      await channel.sendMessage(message.chatId, this.buildReply(response));
    }
  }

  private buildReply(text: string): MessageContent {
    return { text };
  }

  /**
   * Resolve a scoped tool list from an allowedTools name list.
   * Returns undefined when no scoping is needed (uses default copilot tool set).
   */
  private resolveScopedTools(allowedTools?: string[]) {
    if (!allowedTools || !this.toolRegistry) {
      return undefined;
    }
    const allowedSet = new Set([...allowedTools, ...ALWAYS_ON_TOOLS]);
    return this.toolRegistry
      .listEnabledTools()
      .filter((t) => allowedSet.has(t.name));
  }

  private async getOrCreateSessionId(message: IncomingMessage): Promise<string> {
    const key = this.keyFor(message.channelType, message.userId);
    const existing = this.userSessions.get(key);
    if (existing) {
      return existing;
    }

    const sessions = await this.sessionManager.listSessions({
      channel: message.channelType,
      userId: message.userId
    });

    // Find the first active (non-ended) session
    const active = sessions.find((s) => !s.metadata?.ended);
    if (active) {
      this.userSessions.set(key, active.id);
      return active.id;
    }

    const session = await this.sessionManager.createSession({
      channel: message.channelType,
      userId: message.userId,
      metadata: {
        channelId: message.channelId,
        chatId: message.chatId,
        username: message.username
      }
    });

    this.userSessions.set(key, session.id);
    return session.id;
  }

  private buildPrompt(history: ConversationEvent[], message: string): string {
    const lines: string[] = [];
    const personality = this.personalityManager?.getConfig();

    // System instruction & pre-prompt injection
    if (personality?.enabled) {
      if (personality.systemInstruction) {
        lines.push(`System: ${personality.systemInstruction}`);
        lines.push("");
      }
      if (personality.prePrompt) {
        lines.push(personality.prePrompt);
        lines.push("");
      }
    }

    if (history.length > 0) {
      lines.push("Conversation so far:");
      for (const event of history) {
        let label = "User";
        switch (event.type) {
          case "assistant":
            label = "Assistant";
            break;
          case "tool_call":
            label = "Tool call";
            break;
          case "tool_result":
            label = "Tool result";
            break;
          case "user":
            label = "User";
            break;
        }
        lines.push(`${label}: ${event.content}`);
      }
      lines.push("");
    }

    lines.push(`User: ${message}`);

    // Post-prompt injection
    if (personality?.enabled && personality.postPrompt) {
      lines.push("");
      lines.push(personality.postPrompt);
    }

    return lines.join("\n");
  }

  private isAllowed(message: IncomingMessage): boolean {
    const key = this.keyFor(message.channelType, message.userId);
    switch (this.accessControl.mode) {
      case "open":
        return true;
      case "allowlist":
        return this.accessControl.allowedUsers.includes(key);
      case "blocklist":
        return !this.accessControl.blockedUsers.includes(key);
      default:
        return false;
    }
  }

  private keyFor(channelType: string, userId: string): string {
    return `${channelType}:${userId}`;
  }
}
