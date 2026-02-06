import { nanoid } from "nanoid";
import type { Server as SocketIOServer, Socket } from "socket.io";
import type {
  ApprovalRequest,
  ApprovalResponse,
  IncomingMessage,
  MessageChannel,
  MessageContent
} from "./types.js";

export type WebChatChannelOptions = {
  io: SocketIOServer;
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
  private connected = false;
  private sockets = new Map<string, SocketEntry>();
  private chatIdToSocketId = new Map<string, string>();
  private messageHandlers: Array<(msg: IncomingMessage) => void> = [];
  private approvalHandlers: Array<(response: ApprovalResponse) => void> = [];

  constructor({ io }: WebChatChannelOptions) {
    this.io = io;
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
    const chatId = nanoid();
    const entry: SocketEntry = { socketId: socket.id, chatId, socket };
    this.sockets.set(socket.id, entry);
    this.chatIdToSocketId.set(chatId, socket.id);

    socket.emit("chat:connected", { chatId });

    socket.on("chat:message", (data: { content?: string; model?: string }) => {
      const content = typeof data?.content === "string" ? data.content.trim() : "";
      if (!content) {
        return;
      }
      const message: IncomingMessage = {
        channelType: "web",
        channelId: "web-chat",
        chatId,
        userId: `web:${chatId}`,
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
}
