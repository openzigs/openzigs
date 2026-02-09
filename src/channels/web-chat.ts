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

export type WebChatChannelOptions = {
  io: SocketIOServer;
  /** When provided, session history is sent to clients on connect. */
  sessionManager?: SessionManager;
};

type SocketEntry = {
  socketId: string;
  chatId: string;
  socket: Socket;
};

export class WebChatChannel implements MessageChannel {
  readonly id = "web-chat";
  readonly type = "web" as const;

  private io: SocketIOServer;
  private sessionManager?: SessionManager;
  private connected = false;
  private sockets = new Map<string, SocketEntry>();
  private chatIdToSocketId = new Map<string, string>();
  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private approvalHandlers: Array<(response: ApprovalResponse) => void> = [];

  constructor({ io, sessionManager }: WebChatChannelOptions) {
    this.io = io;
    this.sessionManager = sessionManager;
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

    socket.on("chat:message", (data: { content?: string; model?: string }) => {
      const content = typeof data?.content === "string" ? data.content.trim() : "";
      if (!content) {
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

    // Allow the client to re-request its session info (e.g. after a client-side
    // navigation where the ChatView remounts but the socket stays connected).
    socket.on("chat:request-session", () => {
      socket.emit("chat:connected", { chatId });
      if (clientId && this.sessionManager) {
        void this.sendSessionHistory(socket, userId).catch(() => {});
      }
    });

    // Clear the current session history on the server
    socket.on("chat:clear", () => {
      if (this.sessionManager) {
        void this.clearSessionHistory(userId).then((cleared) => {
          socket.emit("chat:cleared", { success: cleared });
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

  /** Load the most recent web session for this userId and send conversation history to the socket. */
  private async sendSessionHistory(socket: Socket, userId: string): Promise<void> {
    if (!this.sessionManager) return;
    const sessions = await this.sessionManager.listSessions({ channel: "web", userId });
    if (sessions.length === 0) return;
    const session = sessions[0];
    const history = await this.sessionManager.getHistory(session.id, 50);

    // If the session was cleared, only show events after the clear timestamp
    const clearedAt = typeof session.metadata?.clearedAt === "string"
      ? new Date(session.metadata.clearedAt).getTime()
      : 0;

    const messages = history
      .filter((event) =>
        (event.type === "user" || event.type === "assistant") &&
        event.timestamp.getTime() > clearedAt
      )
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
