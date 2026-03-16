import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNotificationTools } from "./notification-tools.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockChannelManager(channels: { telegram?: boolean; discord?: boolean } = { telegram: true }) {
  const telegramSend = vi.fn().mockResolvedValue(undefined);
  const discordSend = vi.fn().mockResolvedValue(undefined);
  return {
    manager: {
      getChannel: vi.fn().mockImplementation((type: string) => {
        if (type === "telegram" && channels.telegram) return { sendMessage: telegramSend };
        if (type === "discord" && channels.discord) return { sendMessage: discordSend };
        return null;
      }),
    },
    telegramSend,
    discordSend,
  };
}

describe("notification-tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates tool with correct metadata", () => {
    const { manager } = createMockChannelManager();
    const tools = createNotificationTools({ channelManager: manager as any });
    expect(tools[0].name).toBe("send-notification");
    expect(tools[0].riskLevel).toBe("low");
  });

  it("sends notification to telegram", async () => {
    const { manager, telegramSend } = createMockChannelManager();
    const tools = createNotificationTools({
      channelManager: manager as any,
      fallbackChatId: "123456",
    });
    const result = await tools[0].handler({ message: "Task complete!" });
    expect(telegramSend).toHaveBeenCalledWith("123456", { text: "Task complete!" });
    expect(result.text).toContain("Telegram: sent");
  });

  it("sends notification to discord when configured", async () => {
    const { manager, discordSend } = createMockChannelManager({ discord: true });
    const tools = createNotificationTools({
      channelManager: manager as any,
      discordNotificationChannelId: "chan-789",
    });
    const result = await tools[0].handler({ message: "Done!" });
    expect(discordSend).toHaveBeenCalledWith("chan-789", { text: "Done!" });
    expect(result.text).toContain("Discord: sent");
  });

  it("sends to both channels when both configured", async () => {
    const { manager, telegramSend, discordSend } = createMockChannelManager({ telegram: true, discord: true });
    const tools = createNotificationTools({
      channelManager: manager as any,
      fallbackChatId: "123",
      discordNotificationChannelId: "456",
    });
    const result = await tools[0].handler({ message: "Hello" });
    expect(telegramSend).toHaveBeenCalled();
    expect(discordSend).toHaveBeenCalled();
    expect(result.text).toContain("Telegram: sent");
    expect(result.text).toContain("Discord: sent");
  });

  it("returns skip message when no channels configured", async () => {
    const { manager } = createMockChannelManager({});
    const tools = createNotificationTools({ channelManager: manager as any });
    const result = await tools[0].handler({ message: "Hello" });
    expect(result.text).toContain("No notification channels configured");
  });

  it("handles send failure gracefully", async () => {
    const { manager, telegramSend } = createMockChannelManager();
    telegramSend.mockRejectedValue(new Error("Network error"));
    const tools = createNotificationTools({
      channelManager: manager as any,
      fallbackChatId: "123",
    });
    const result = await tools[0].handler({ message: "Hello" });
    expect(result.text).toContain("Telegram: failed");
  });
});
