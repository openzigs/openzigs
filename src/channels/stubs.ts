import type {
  ApprovalRequest,
  ApprovalResponse,
  IncomingMessage,
  MessageChannel,
  MessageContent,
  ChannelType
} from "./types.js";

const createHandlerStore = <T>() => {
  const handlers: Array<(payload: T) => void> = [];
  return {
    add(handler: (payload: T) => void) {
      handlers.push(handler);
    },
    emit(payload: T) {
      for (const handler of handlers) {
        handler(payload);
      }
    }
  };
};

abstract class BaseChannel implements MessageChannel {
  readonly id: string;
  readonly type: ChannelType;
  private connected = false;
  private messageHandlers = createHandlerStore<IncomingMessage>();
  private approvalHandlers = createHandlerStore<ApprovalResponse>();

  protected constructor(id: string, type: ChannelType) {
    this.id = id;
    this.type = type;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandlers.add(handler);
  }

  onApprovalResponse(handler: (response: ApprovalResponse) => void): void {
    this.approvalHandlers.add(handler);
  }

  protected emitMessage(message: IncomingMessage) {
    this.messageHandlers.emit(message);
  }

  protected emitApprovalResponse(response: ApprovalResponse) {
    this.approvalHandlers.emit(response);
  }

  async sendMessage(_chatId: string, _content: MessageContent): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
  }

  async sendApprovalRequest(_chatId: string, _request: ApprovalRequest): Promise<void> {
    if (!this.connected) {
      throw new Error("Channel is not connected");
    }
  }
}

export class WebChannel extends BaseChannel {
  constructor(id = "web") {
    super(id, "web");
  }
}
