import { nanoid } from "nanoid";
import type { Server as SocketIOServer, Socket } from "socket.io";
import type {
  ApprovalRequest,
  ApprovalResponse,
  IncomingMessage,
  MessageChannel,
  MessageContent
} from "./types.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { UserInputRequest, UserInputResponse, SdkAttachment } from "../copilot/copilot-wrapper.js";

export type WebChatChannelOptions = {
  io: SocketIOServer;
  /** When provided, session history is sent to clients on connect. */
  sessionManager?: SessionManager;
  /** Timeout in ms for interactive user input requests. Default 60_000 (60s). */
  userInputTimeoutMs?: number;
};

type SocketEntry = {
  socketId: string;
  chatId: string;
  socket: Socket;
};

type PendingInputRequest = {
  resolve: (response: UserInputResponse) => void;
  timer: ReturnType<typeof setTimeout>;
};

const MAX_CHAT_MESSAGE_CHARS = 10_000;

export class WebChatChannel implements MessageChannel {
  readonly id = "web-chat";
  readonly type = "web" as const;

  private io: SocketIOServer;
  private sessionManager?: SessionManager;
  private userInputTimeoutMs: number;
  private connected = false;
  private sockets = new Map<string, SocketEntry>();
  private chatIdToSocketId = new Map<string, string>();
  private pendingInputRequests = new Map<string, PendingInputRequest>();
  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private approvalHandlers: Array<(response: ApprovalResponse) => void> = [];
  private clearHandlers: Array<(data: { userId: string }) => void> = [];

  constructor({ io, sessionManager, userInputTimeoutMs }: WebChatChannelOptions) {
    this.io = io;
    this.sessionManager = sessionManager;
    this.userInputTimeoutMs = userInputTimeoutMs ?? 60_000;
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.io.on("connection", (socket) => this.handleConnection(socket));
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sockets.clear();
    this.chatIdToSocketId.clear();
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.push(handler);
  }

  onApprovalResponse(handler: (response: ApprovalResponse) => void): void {
    this.approvalHandlers.push(handler);
  }

  /** Register a handler called when a user clears their chat (session ended). */
  onClear(handler: (data: { userId: string }) => void): void {
    this.clearHandlers.push(handler);
  }

  async sendMessage(chatId: string, content: MessageContent): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
    const socket = this.getSocketByChatId(chatId);
    if (socket) {
      socket.emit("chat:response", { content: content.text, done: true });
    }
  }

  async sendStreamChunk(chatId: string, chunk: string, messageId: string): Promise<void> {
    const socket = this.getSocketByChatId(chatId);
    if (socket) {
      socket.emit("chat:stream", { chunk, messageId });
    }
  }

  async sendStreamEnd(chatId: string, messageId: string): Promise<void> {
    const socket = this.getSocketByChatId(chatId);
    if (socket) {
      socket.emit("chat:stream:end", { messageId });
    }
  }

  async sendError(chatId: string, error: string): Promise<void> {
    const socket = this.getSocketByChatId(chatId);
    if (socket) {
      socket.emit("chat:error", { error });
    }
  }

  async sendToolProgress(chatId: string, tool: string): Promise<void> {
    const socket = this.getSocketByChatId(chatId);
    if (socket) {
      socket.emit("chat:tool_call", { tool });
    }
  }

  async sendApprovalRequest(chatId: string, request: ApprovalRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
    const socket = this.getSocketByChatId(chatId);
    if (socket) {
      socket.emit("approval:request", request);
    }
  }

  /**
   * Send an interactive user input request to the client and wait for a response.
   * Returns a Promise that resolves with the user's answer or rejects on timeout.
   */
  async sendUserInputRequest(chatId: string, request: UserInputRequest): Promise<UserInputResponse> {
    const socket = this.getSocketByChatId(chatId);
    if (!socket) {
      return { answer: "", wasFreeform: false };
    }

    const requestId = nanoid();
    return new Promise<UserInputResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingInputRequests.delete(requestId);
        resolve({ answer: "", wasFreeform: false });
      }, this.userInputTimeoutMs);

      this.pendingInputRequests.set(requestId, { resolve, timer });
      socket.emit("user_input_request", {
        requestId,
        question: request.question,
        choices: request.choices,
        allowFreeform: request.allowFreeform ?? true,
        preview: request.preview,
      });
    });
  }

  private handleConnection(socket: Socket) {
    const clientId = typeof socket.handshake.query.clientId === "string"
      ? socket.handshake.query.clientId
      : undefined;
    const chatId = nanoid();
    const userId = clientId ? `web:${clientId}` : `web:${chatId}`;
    const entry: SocketEntry = { socketId: socket.id, chatId, socket };
    this.sockets.set(socket.id, entry);
    this.chatIdToSocketId.set(chatId, socket.id);

    socket.emit("chat:connected", { chatId });

    // Send session history to reconnecting clients
    if (clientId && this.sessionManager) {
      void this.sendSessionHistory(socket, userId).catch(() => {});
    }

    socket.on("chat:message", (data: { content?: string; model?: string; tools?: string[]; files?: SdkAttachment[]; workingDirectory?: string }) => {
      const content = typeof data?.content === "string" ? data.content.trim() : "";
      if (!content) {
        return;
      }
      if (content.length > MAX_CHAT_MESSAGE_CHARS) {
        socket.emit("chat:error", {
          error: `Message too long (${content.length} chars). Max allowed is ${MAX_CHAT_MESSAGE_CHARS}.`,
        });
        return;
      }
      const message: IncomingMessage = {
        channelType: "web",
        channelId: "web-chat",
        chatId,
        userId,
        username: "web-user",
        content,
        model: data.model,
        tools: Array.isArray(data.tools) ? data.tools : undefined,
        files: Array.isArray(data.files) ? data.files : undefined,
        workingDirectory: typeof data.workingDirectory === "string" ? data.workingDirectory : undefined,
        timestamp: new Date()
      };
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    socket.on("approval:response", (data: { approvalId?: string; approved?: boolean }) => {
      if (typeof data?.approvalId !== "string" || typeof data?.approved !== "boolean") {
        return;
      }
      const response: ApprovalResponse = {
        approvalId: data.approvalId,
        approved: data.approved,
        decidedBy: `web:${chatId}`,
        decidedVia: "web",
        decidedAt: new Date()
      };
      for (const handler of this.approvalHandlers) {
        handler(response);
      }
    });

    // Handle user input responses for interactive clarifications
    socket.on("user_input_response", (data: { requestId?: string; answer?: string; wasFreeform?: boolean }) => {
      const requestId = typeof data?.requestId === "string" ? data.requestId : "";
      const answer = typeof data?.answer === "string" ? data.answer : "";
      const wasFreeform = typeof data?.wasFreeform === "boolean" ? data.wasFreeform : true;
      if (!requestId) return;

      const pending = this.pendingInputRequests.get(requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingInputRequests.delete(requestId);
        pending.resolve({ answer, wasFreeform });
      }
    });

    // Allow the client to re-request its session info (e.g. after a client-side
    // navigation where the ChatView remounts but the socket stays connected).
    socket.on("chat:request-session", () => {
      socket.emit("chat:connected", { chatId });
      if (clientId && this.sessionManager) {
        void this.sendSessionHistory(socket, userId).catch(() => {});
      }
    });

    // End the current session and start fresh on next message
    socket.on("chat:clear", () => {
      if (this.sessionManager) {
        void this.clearSessionHistory(userId).then((cleared) => {
          socket.emit("chat:cleared", { success: cleared });
          if (cleared) {
            for (const handler of this.clearHandlers) {
              handler({ userId });
            }
          }
        }).catch(() => {
          socket.emit("chat:cleared", { success: false });
        });
      }
    });

    // Restore a specific session's history into the chat window
    socket.on("chat:restore-session", (data: { sessionId?: string }) => {
      const sessionId = typeof data?.sessionId === "string" ? data.sessionId : "";
      if (!sessionId || !this.sessionManager) return;
      // Emit chat:connected so the client gets a chatId (it may have skipped chat:request-session)
      socket.emit("chat:connected", { chatId });
      void this.restoreSession(socket, sessionId).catch(() => {
        socket.emit("chat:error", { error: `Failed to restore session ${sessionId}` });
      });
    });

    socket.on("disconnect", () => {
      this.sockets.delete(socket.id);
      this.chatIdToSocketId.delete(chatId);
    });
  }

  private getSocketByChatId(chatId: string): Socket | undefined {
    const socketId = this.chatIdToSocketId.get(chatId);
    if (!socketId) {
      return undefined;
    }
    return this.sockets.get(socketId)?.socket;
  }

  /** Load the most recent active (non-ended) web session for this userId and send conversation history to the socket. */
  private async sendSessionHistory(socket: Socket, userId: string): Promise<void> {
    if (!this.sessionManager) return;
    const sessions = await this.sessionManager.listSessions({ channel: "web", userId });
    // Find the latest active (non-ended) session
    const session = sessions.find((s) => !s.metadata?.ended);
    if (!session) return;
    const history = await this.sessionManager.getHistory(session.id, 50);

    const messages = history
      .filter((event) => event.type === "user" || event.type === "assistant")
      .map((event) => ({
        role: event.type as "user" | "assistant",
        content: event.content,
        timestamp: event.timestamp.toISOString(),
      }));
    if (messages.length > 0) {
      socket.emit("chat:history", { messages });
    }
  }

  /** Clear the most recent web session's conversation history. */
  private async clearSessionHistory(userId: string): Promise<boolean> {
    if (!this.sessionManager) return false;
    const sessions = await this.sessionManager.listSessions({ channel: "web", userId });
    if (sessions.length === 0) return false;
    await this.sessionManager.clearSession(sessions[0].id);
    return true;
  }

  /** Load a specific session's history and send it to the socket. */
  private async restoreSession(socket: Socket, sessionId: string): Promise<void> {
    if (!this.sessionManager) return;
    const history = await this.sessionManager.getHistory(sessionId, 50);
    const messages = history
      .filter((event) => event.type === "user" || event.type === "assistant")
      .map((event) => ({
        role: event.type as "user" | "assistant",
        content: event.content,
        timestamp: event.timestamp.toISOString(),
      }));
    // Send as history (replaces current chat messages on client)
    socket.emit("chat:history", { messages, restored: true });
  }
}
