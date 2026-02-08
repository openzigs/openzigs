import type { ChannelManager } from "../channels/channel-manager.js";
import type { IncomingMessage, MessageContent } from "../channels/types.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { AccessControlConfig } from "../config/index.js";
import type { ConversationEvent, SessionManager } from "../sessions/session-manager.js";
import { ALWAYS_ON_TOOLS } from "../mcp/constants.js";

export type RouteOptions = {
  /** Callback invoked for each streaming chunk. */
  onChunk?: (chunk: string) => void;
  /** Override the model for this request. */
  model?: string;
};

export type MessageRouterOptions = {
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  copilot: CopilotWrapper;
  accessControl?: AccessControlConfig;
  historyLimit?: number;
  maxToolsPerRequest?: number;
  clock?: () => Date;
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
  private userSessions = new Map<string, string>();
  private accessControl: AccessControlConfig;
  private historyLimit: number;
  public readonly maxToolsPerRequest: number;
  private clock: () => Date;

  constructor({
    channelManager,
    sessionManager,
    copilot,
    accessControl,
    historyLimit = 20,
    maxToolsPerRequest = 30,
    clock
  }: MessageRouterOptions) {
    this.channelManager = channelManager;
    this.sessionManager = sessionManager;
    this.copilot = copilot;
    this.accessControl = accessControl ?? defaultAccessControl;
    this.historyLimit = historyLimit;
    this.maxToolsPerRequest = maxToolsPerRequest;
    this.clock = clock ?? (() => new Date());
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
    const resume = await this.sessionManager.resumeSession(sessionId, this.historyLimit);
    const prompt = this.buildPrompt(resume.history, message.content);

    let response = "";
    for await (const chunk of this.copilot.chat(prompt, undefined, options?.model)) {
      response += chunk;
      if (options?.onChunk) {
        options.onChunk(chunk);
      }
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

    if (sessions.length > 0) {
      const sessionId = sessions[0].id;
      this.userSessions.set(key, sessionId);
      return sessionId;
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
