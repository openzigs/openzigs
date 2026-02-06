import type { ChannelType, MessageChannel, MessageContent } from "./types.js";

export type ChannelBroadcastMap = Map<ChannelType, string[]>;

export class ChannelManager {
  private channels = new Map<ChannelType, MessageChannel>();

  register(channel: MessageChannel): void {
    this.channels.set(channel.type, channel);
  }

  getChannel(type: ChannelType): MessageChannel | undefined {
    return this.channels.get(type);
  }

  listChannels(): MessageChannel[] {
    return Array.from(this.channels.values());
  }

  async broadcast(content: MessageContent, chatIds: ChannelBroadcastMap): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [type, ids] of chatIds.entries()) {
      const channel = this.channels.get(type);
      if (!channel) {
        continue;
      }
      for (const chatId of ids) {
        tasks.push(channel.sendMessage(chatId, content));
      }
    }
    await Promise.all(tasks);
  }
}
