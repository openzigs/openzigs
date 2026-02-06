import { describe, expect, it } from "vitest";
import { ChannelManager } from "./channel-manager.js";
import { TelegramChannel } from "./stubs.js";

const createChatMap = () => {
  return new Map([["telegram", ["chat-1", "chat-2"]]]) as Map<"telegram", string[]>;
};

describe("ChannelManager", () => {
  it("registers and retrieves channels", () => {
    const manager = new ChannelManager();
    const channel = new TelegramChannel();
    manager.register(channel);

    expect(manager.getChannel("telegram")).toBe(channel);
    expect(manager.listChannels()).toHaveLength(1);
  });

  it("broadcasts to registered channels", async () => {
    const manager = new ChannelManager();
    const channel = new TelegramChannel();
    await channel.connect();
    manager.register(channel);

    await manager.broadcast({ text: "hello" }, createChatMap());
  });
});
