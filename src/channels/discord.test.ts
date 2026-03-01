import { describe, expect, it, vi } from "vitest";
import type { ApprovalResponse, MessageContent } from "./types.js";
import { DiscordChannel } from "./discord.js";

type MessageHandler = (payload: unknown) => void;

type MockChannel = {
  isTextBased: () => boolean;
  send: (options: { content: string; components?: unknown[] }) => Promise<void>;
};

class MockClient {
  channelsMap = new Map<string, MockChannel>();
  handlers = new Map<string, MessageHandler>();
  loginCalls: string[] = [];

  channels = {
    fetch: async (id: string) => this.channelsMap.get(id) ?? null
  };

  on(event: "messageCreate" | "interactionCreate", handler: MessageHandler) {
    this.handlers.set(event, handler);
  }

  async login(token: string) {
    this.loginCalls.push(token);
  }

  destroy() {
    return undefined;
  }

  emit(event: "messageCreate" | "interactionCreate", payload: unknown) {
    const handler = this.handlers.get(event);
    if (handler) {
      handler(payload);
    }
  }
}

describe("DiscordChannel", () => {
  it("splits long messages into multiple sends", async () => {
    const client = new MockClient();
    const calls: Array<{ content: string }> = [];
    client.channelsMap.set("chat-1", {
      isTextBased: () => true,
      send: async (options) => {
        calls.push({ content: options.content });
      }
    });

    const channel = new DiscordChannel({
      config: {
        botToken: "token",
        allowedGuilds: [],
      },
      client
    });

    await channel.connect();

    const content: MessageContent = {
      text: "a".repeat(5000),
      markdown: false
    };

    await channel.sendMessage("chat-1", content);

    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.content.length).toBeLessThanOrEqual(2000);
    }
  });

  it("emits approval response for button interactions", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: {
        botToken: "token",
        allowedGuilds: [],
      },
      client
    });

    await channel.connect();

    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((response) => responses.push(response));

    const interaction = {
      isButton: () => true,
      customId: "approve:approval-1",
      message: { content: "Permission Required" },
      user: { id: "user-1" },
      update: async () => undefined
    };

    client.emit("interactionCreate", interaction);

    expect(responses).toHaveLength(1);
    expect(responses[0].approvalId).toBe("approval-1");
    expect(responses[0].approved).toBe(true);
  });

  it("ignores messages from non-allowlisted guilds", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: {
        botToken: "token",
        allowedGuilds: ["guild-1"]
      },
      client
    });

    await channel.connect();

    const received: string[] = [];
    channel.onMessage((message) => received.push(message.content));

    client.emit("messageCreate", {
      author: { id: "user-1", username: "ada", bot: false },
      channelId: "channel-1",
      channel: { isDMBased: () => false },
      guildId: "guild-2",
      content: "ignored",
      createdAt: new Date()
    });

    client.emit("messageCreate", {
      author: { id: "user-1", username: "ada", bot: false },
      channelId: "channel-2",
      channel: { isDMBased: () => false },
      guildId: "guild-1",
      content: "accepted",
      createdAt: new Date()
    });

    expect(received).toEqual(["accepted"]);
  });

  it("ignores bot messages", () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: ["guild-1"] },
      client
    });

    const received: string[] = [];
    channel.onMessage((msg) => received.push(msg.content));

    client.emit("messageCreate", {
      author: { id: "bot-1", username: "bot", bot: true },
      channelId: "ch-1",
      channel: { isDMBased: () => false },
      guildId: "guild-1",
      content: "bot message",
      createdAt: new Date()
    });

    expect(received).toEqual([]);
  });

  it("ignores empty and slash-command messages", () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: ["guild-1"] },
      client
    });

    const received: string[] = [];
    channel.onMessage((msg) => received.push(msg.content));

    // Empty
    client.emit("messageCreate", {
      author: { id: "u1", username: "ada", bot: false },
      channelId: "ch-1", channel: { isDMBased: () => false },
      guildId: "guild-1", content: "   ", createdAt: new Date()
    });
    // Slash command
    client.emit("messageCreate", {
      author: { id: "u1", username: "ada", bot: false },
      channelId: "ch-1", channel: { isDMBased: () => false },
      guildId: "guild-1", content: "/help", createdAt: new Date()
    });

    expect(received).toEqual([]);
  });

  it("accepts DM messages regardless of guild allowlist", () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });

    const received: string[] = [];
    channel.onMessage((msg) => received.push(msg.content));

    client.emit("messageCreate", {
      author: { id: "u1", username: "ada", bot: false },
      channelId: "dm-1",
      channel: { isDMBased: () => true },
      guildId: null,
      content: "hello via DM",
      createdAt: new Date()
    });

    expect(received).toEqual(["hello via DM"]);
  });

  it("connect() logs and re-throws on login failure", async () => {
    const client = new MockClient();
    client.login = async () => { throw new Error("Invalid token"); };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const channel = new DiscordChannel({
      config: { botToken: "bad-token", allowedGuilds: [] },
      client,
      logger: logger as never
    });

    await expect(channel.connect()).rejects.toThrow("Invalid token");
    expect(logger.error).toHaveBeenCalled();
    expect(channel.isConnected()).toBe(false);
  });

  it("disconnect() destroys client and sets connected false", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });

    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);

    // Second disconnect is a no-op
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it("sendMessage throws when not connected", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });

    await expect(channel.sendMessage("ch-1", { text: "hi", markdown: false }))
      .rejects.toThrow("Channel is not connected");
  });

  it("sendMessage returns early when channel is null or not text-based", async () => {
    const client = new MockClient();
    client.channelsMap.set("non-text", { isTextBased: () => false, send: async () => {} });
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });
    await channel.connect();

    // Channel not found
    await channel.sendMessage("missing", { text: "hi", markdown: false });
    // Channel not text-based
    await channel.sendMessage("non-text", { text: "hi", markdown: false });
  });

  it("sendApprovalRequest sends formatted message with buttons", async () => {
    const client = new MockClient();
    const sentMessages: Array<{ content: string; components?: unknown[] }> = [];
    client.channelsMap.set("ch-1", {
      isTextBased: () => true,
      send: async (opts) => { sentMessages.push(opts); }
    });

    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });
    await channel.connect();

    await channel.sendApprovalRequest("ch-1", {
      id: "req-1",
      tool: "shell-execute",
      riskLevel: "high",
      explanation: "Running rm -rf",
      args: {}
    });

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content).toContain("shell-execute");
    expect(sentMessages[0].components).toBeDefined();
  });

  it("sendApprovalRequest throws when not connected", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });

    await expect(channel.sendApprovalRequest("ch-1", {
      id: "req-1", tool: "test", riskLevel: "medium", explanation: "test", args: {}
    })).rejects.toThrow("Channel is not connected");
  });

  it("handles reject button interaction", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });
    await channel.connect();

    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((r) => responses.push(r));

    client.emit("interactionCreate", {
      isButton: () => true,
      customId: "reject:approval-2",
      message: { content: "Permission Required" },
      user: { id: "user-2" },
      update: async () => undefined
    });

    expect(responses).toHaveLength(1);
    expect(responses[0].approved).toBe(false);
    expect(responses[0].approvalId).toBe("approval-2");
  });

  it("ignores non-button interactions and invalid customIds", () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });

    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((r) => responses.push(r));

    // Non-button interaction
    client.emit("interactionCreate", { isButton: () => false });
    // Invalid action
    client.emit("interactionCreate", {
      isButton: () => true,
      customId: "unknown:id-1",
      update: async () => undefined
    });
    // No approval ID
    client.emit("interactionCreate", {
      isButton: () => true,
      customId: "approve",
      update: async () => undefined
    });

    expect(responses).toEqual([]);
  });

  it("connect() is idempotent when already connected", async () => {
    const client = new MockClient();
    const channel = new DiscordChannel({
      config: { botToken: "token", allowedGuilds: [] },
      client
    });

    await channel.connect();
    await channel.connect(); // should be a no-op
    expect(client.loginCalls).toHaveLength(1);
  });
});
