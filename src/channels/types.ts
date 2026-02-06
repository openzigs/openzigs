export type ChannelType = "discord" | "telegram" | "slack" | "web";

export type Attachment = {
  id?: string;
  name?: string;
  url?: string;
  mimeType?: string;
  sizeBytes?: number;
};

export type Button = {
  id: string;
  label: string;
  action?: string;
  url?: string;
};

export type MessageContent = {
  text: string;
  markdown?: boolean;
  buttons?: Button[];
  attachments?: Attachment[];
};

export type IncomingMessage = {
  channelType: ChannelType;
  channelId: string;
  chatId: string;
  userId: string;
  username?: string;
  content: string;
  attachments?: Attachment[];
  timestamp: Date;
};

export type ApprovalRequest = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  riskLevel: "medium" | "high";
  explanation: string;
  preview?: string;
};

export type ApprovalResponse = {
  approvalId: string;
  approved: boolean;
  decidedBy?: string;
  decidedVia: ChannelType;
  decidedAt: Date;
};

export interface MessageChannel {
  readonly id: string;
  readonly type: ChannelType;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  sendMessage(chatId: string, content: MessageContent): Promise<void>;
  sendApprovalRequest(chatId: string, request: ApprovalRequest): Promise<void>;

  onMessage(handler: (msg: IncomingMessage) => void): void;
  onApprovalResponse(handler: (response: ApprovalResponse) => void): void;
}
