import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./channel-manager.js";
import { DiscordChannel } from "./stubs.js";

const createChatMap = () => {
  return new Map([["discord", ["chat-1", "chat-2"]]]) as Map<"discord", string[]>;
};

describe("ChannelManager", () => {
  it("registers and retrieves channels", () => {
    const manager = new ChannelManager();
    const channel = new DiscordChannel();
    manager.register(channel);

    expect(manager.getChannel("discord")).toBe(channel);
    expect(manager.listChannels()).toHaveLength(1);
  });

  it("broadcasts to registered channels", async () => {
    const manager = new ChannelManager();
    const channel = new DiscordChannel();
    const sendMessageSpy = vi.spyOn(channel, "sendMessage");
    await channel.connect();
    manager.register(channel);

    await manager.broadcast({ text: "hello" }, createChatMap());

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(sendMessageSpy).toHaveBeenCalledWith("chat-1", { text: "hello" });
    expect(sendMessageSpy).toHaveBeenCalledWith("chat-2", { text: "hello" });
  });
});
