import { describe, expect, it } from "vitest";
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
        adminUsers: []
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
        adminUsers: []
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
        allowedGuilds: ["guild-1"],
        adminUsers: []
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
});
