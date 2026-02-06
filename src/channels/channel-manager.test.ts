import { describe, expect, it, vi } from "vitest";
import { ChannelManager } from "./channel-manager.js";
import { WebChannel } from "./stubs.js";

const createChatMap = () => {
  return new Map([["web", ["chat-1", "chat-2"]]]) as Map<"web", string[]>;
};

describe("ChannelManager", () => {
  it("registers and retrieves channels", () => {
    const manager = new ChannelManager();
    const channel = new WebChannel();
    manager.register(channel);

    expect(manager.getChannel("web")).toBe(channel);
    expect(manager.listChannels()).toHaveLength(1);
  });

  it("broadcasts to registered channels", async () => {
    const manager = new ChannelManager();
    const channel = new WebChannel();
    const sendMessageSpy = vi.spyOn(channel, "sendMessage");
    await channel.connect();
    manager.register(channel);

    await manager.broadcast({ text: "hello" }, createChatMap());

    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(sendMessageSpy).toHaveBeenCalledWith("chat-1", { text: "hello" });
    expect(sendMessageSpy).toHaveBeenCalledWith("chat-2", { text: "hello" });
  });
});
