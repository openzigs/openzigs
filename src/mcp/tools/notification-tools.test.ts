import { describe, it, expect, vi, beforeEach } from "vitest";
import { createNotificationTools } from "./notification-tools.js";

vi.mock("../../logging/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function createMockChannelManager(hasTelegram = true) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    manager: {
      getChannel: vi.fn().mockReturnValue(
        hasTelegram ? { sendMessage } : null,
      ),
    },
    sendMessage,
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
    const { manager, sendMessage } = createMockChannelManager();
    const tools = createNotificationTools({
      channelManager: manager as any,
      fallbackChatId: "123456",
    });
    const result = await tools[0].handler({ message: "Task complete!" });
    expect(sendMessage).toHaveBeenCalledWith("123456", { text: "Task complete!" });
    expect(result.text).toContain("Notification sent");
  });

  it("returns skip message when telegram not connected", async () => {
    const { manager } = createMockChannelManager(false);
    const tools = createNotificationTools({ channelManager: manager as any });
    const result = await tools[0].handler({ message: "Hello" });
    expect(result.text).toContain("not connected");
  });

  it("returns skip message when no chat ID configured", async () => {
    const { manager } = createMockChannelManager();
    const tools = createNotificationTools({ channelManager: manager as any });
    const result = await tools[0].handler({ message: "Hello" });
    expect(result.text).toContain("No admin chat ID");
  });

  it("handles send failure gracefully", async () => {
    const { manager, sendMessage } = createMockChannelManager();
    sendMessage.mockRejectedValue(new Error("Network error"));
    const tools = createNotificationTools({
      channelManager: manager as any,
      fallbackChatId: "123",
    });
    const result = await tools[0].handler({ message: "Hello" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Failed to send");
  });
});
