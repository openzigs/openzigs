import type { ChannelManager } from "../channels/channel-manager.js";
import type { IncomingMessage, MessageContent } from "../channels/types.js";
import type { CopilotWrapper } from "../copilot/copilot-wrapper.js";
import type { SystemMessageConfig, UserInputHandler, SdkAttachment, ReasoningEffort } from "../copilot/copilot-wrapper.js";
import type { AccessControlConfig } from "../config/index.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { SecretVaultService } from "../vault/index.js";
import type { PersonalityManager } from "../personality/personality-manager.js";
import type { BrandVoiceService } from "../personality/brand-voice-service.js";
import type { TaskEngine } from "../tasks/task-engine.js";
import { ALWAYS_ON_TOOLS, INTERACTIVE_CHAT_AUTO_APPROVE_TOOLS } from "../mcp/constants.js";
import { setActiveChatContext, clearActiveChatContext } from "../mcp/tools/agent-tools.js";
import { setActiveOrchestrateContext, clearActiveOrchestrateContext } from "../mcp/tools/orchestrate-agents.js";
import { setActiveWizardContext, clearActiveWizardContext } from "../mcp/tools/wizard-tools.js";

export type RouteOptions = {
  /** Callback invoked for each streaming chunk. */
  onChunk?: (chunk: string) => void;
  /** Override the model for this request. */
  model?: string;
  /** Callback invoked when a tool is called during processing. */
  onToolCall?: (tool: string, args: unknown) => void;
  /** Optional tool allowlist for this request. Only these tools (+ ALWAYS_ON_TOOLS) will be available. */
  allowedTools?: string[];
  /** File/directory/selection attachments to include with this message. */
  attachments?: SdkAttachment[];
  /** Working directory context for this message's SDK session. */
  workingDirectory?: string;
  /** Reasoning effort override for this message. */
  reasoningEffort?: ReasoningEffort;
};

export type MessageRouterOptions = {
  channelManager: ChannelManager;
  sessionManager: SessionManager;
  copilot: CopilotWrapper;
  accessControl?: AccessControlConfig;
  historyLimit?: number;
  maxToolsPerRequest?: number;
  clock?: () => Date;
  personalityManager?: PersonalityManager;
  /** When provided, chat messages are tracked as TaskEngine tasks. */
  taskEngine?: TaskEngine;
  /** Handler for interactive user input requests during agent execution. */
  onUserInputRequest?: UserInputHandler;
  /** When provided, vault status is injected into the system prompt so the LLM knows to use get-secret. */
  vaultService?: SecretVaultService;
  /** When provided, active brand voice rules are injected into the system prompt. */
  brandVoiceService?: BrandVoiceService;
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
  private personalityManager?: PersonalityManager;
  private taskEngine?: TaskEngine;
  private userInputHandler?: UserInputHandler;
  private vaultService?: SecretVaultService;
  private brandVoiceService?: BrandVoiceService;

  constructor({
    channelManager,
    sessionManager,
    copilot,
    accessControl,
    historyLimit = 20,
    maxToolsPerRequest = 30,
    clock,
    personalityManager,
    taskEngine,
    onUserInputRequest,
    vaultService,
    brandVoiceService,
  }: MessageRouterOptions) {
    this.channelManager = channelManager;
    this.sessionManager = sessionManager;
    this.copilot = copilot;
    this.vaultService = vaultService;
    this.brandVoiceService = brandVoiceService;
    this.accessControl = accessControl ?? defaultAccessControl;
    this.historyLimit = historyLimit;
    this.maxToolsPerRequest = maxToolsPerRequest;
    this.clock = clock ?? (() => new Date());
    this.personalityManager = personalityManager;
    this.taskEngine = taskEngine;
    this.userInputHandler = onUserInputRequest;
  }

  /** Invalidate the cached session for a user so the next message creates a new session. */
  clearUserSession(channelType: string, userId: string): void {
    const key = this.keyFor(channelType, userId);
    const sessionId = this.userSessions.get(key);
    this.userSessions.delete(key);

    // Also destroy the SDK session to free resources and reset context
    if (sessionId) {
      void this.copilot.destroySession(sessionId);
    }
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

    // Touch the session to update lastActiveAt (history is still persisted for admin/audit views)
    await this.sessionManager.resumeSession(sessionId, this.historyLimit);
    // SDK handles multi-turn context natively; only send the current user message
    const prompt = this.buildPrompt(message.content);
    // Build system message from personality config for SDK-level injection
    const systemMessage = this.buildSystemMessage();

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
      // Set wizard context so workflow-wizard can present interactive preview cards
      setActiveWizardContext({
        requestUserInput: this.userInputHandler,
        sessionId,
      });

      // Resolve SDK-native tool scoping: pass tool name strings instead of filtering ToolDefinition arrays.
      const availableTools = this.resolveAvailableTools(options?.allowedTools);

      // Interactive chat sessions auto-approve high-risk tools.
      // The user is the human-in-the-loop — they initiated the request,
      // so forcing an approval-queue round-trip is just friction.
      // N.B. autoApproveTools is closure-based (captured in buildSessionConfig),
      // NOT AsyncLocalStorage — the latter is lost across JSON-RPC boundaries.
      for await (const chunk of this.copilot.chat(prompt, {
        model: options?.model,
        onToolCall: options?.onToolCall,
        conversationId: sessionId,
        systemMessage,
        availableTools,
        onUserInputRequest: this.userInputHandler,
        attachments: options?.attachments,
        workingDirectory: options?.workingDirectory,
        reasoningEffort: options?.reasoningEffort,
        autoApproveTools: INTERACTIVE_CHAT_AUTO_APPROVE_TOOLS,
      })) {
        response += chunk;
        if (options?.onChunk) {
          options.onChunk(chunk);
        }
      }

      clearActiveChatContext();
      clearActiveOrchestrateContext();
      clearActiveWizardContext();

      // Mark task completed
      if (taskId && this.taskEngine) {
        this.taskEngine.complete(taskId, response.slice(0, 500));
      }
    } catch (error) {
      clearActiveChatContext();
      clearActiveOrchestrateContext();
      clearActiveWizardContext();
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
   * Resolve SDK-native availableTools from a caller-provided allowedTools list.
   * Merges ALWAYS_ON_TOOLS into the list. Returns undefined when no scoping is needed.
   */
  private resolveAvailableTools(allowedTools?: string[]): string[] | undefined {
    if (!allowedTools) {
      return undefined;
    }
    return [...new Set([...allowedTools, ...ALWAYS_ON_TOOLS])];
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

  /**
   * Build the SDK-level system message from personality config + vault context.
   * Returns undefined only when there is nothing to inject.
   */
  private buildSystemMessage(): SystemMessageConfig | undefined {
    const personality = this.personalityManager?.getConfig();
    const vaultContext = this.buildVaultSystemContext();

    const brandVoiceBlock = this.brandVoiceService?.getActiveVoicePromptBlock();

    const parts = [
      ...(personality?.enabled
        ? [personality.systemInstruction, personality.prePrompt, personality.postPrompt]
        : []),
      brandVoiceBlock,
      vaultContext,
    ].filter(Boolean);

    if (parts.length === 0) {
      return undefined;
    }

    return {
      mode: personality?.mode ?? "append",
      content: parts.join("\n\n"),
    };
  }

  /**
   * Build vault awareness context for the system prompt.
   * When the vault is unlocked and has secrets, injects instructions
   * so the LLM uses get-secret + browser-navigate instead of asking for passwords.
   * When locked, injects a notice so the model can tell the user to unlock.
   */
  private buildVaultSystemContext(): string | undefined {
    if (!this.vaultService) return undefined;

    if (!this.vaultService.isUnlocked()) {
      // Vault exists but is locked — tell the model so it can instruct the user.
      return (
        "[Secret Vault]\n" +
        "The user has a secret vault but it is currently LOCKED. " +
        "When the user asks to log in or use stored credentials, tell them to unlock the vault first " +
        "via the Admin → Vault panel, then retry. Do NOT ask for passwords directly.\n" +
        "You have list-secrets and get-secret tools available — they will work once the vault is unlocked."
      );
    }

    const secrets = this.vaultService.listSecrets();
    if (secrets.length === 0) return undefined;

    const available = secrets
      .map((s) => {
        const parts = [s.label];
        if (s.service) parts.push(`(${s.service})`);
        if (s.username) parts.push(`[${s.username}]`);
        return parts.join(" ");
      })
      .join(", ");

    return (
      "[Secret Vault]\n" +
      "The user has a secret vault with stored credentials. When the user asks to log in, sign in, " +
      "enter a password, or use credentials for any website or service, you MUST:\n" +
      "1. Call list-secrets to see available credentials.\n" +
      "2. Call get-secret with the matching label to get a {{SECRET:<uuid>}} token.\n" +
      "3. Use browser-navigate with action 'type' and the token as the text parameter.\n" +
      "A direct user request to log in with their credentials is explicit consent to retrieve and use the matching vault secret.\n" +
      "Do NOT ask a follow-up permission question before calling list-secrets/get-secret in that case.\n" +
      "NEVER ask the user to provide their password or credentials directly in chat.\n" +
      `Available secrets: ${available}`
    );
  }

  private buildPrompt(message: string): string {
    // Personality is now injected via SDK systemMessage — prompt only contains the user message.
    return `User: ${message}`;
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
