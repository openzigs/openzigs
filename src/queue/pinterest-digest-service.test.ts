import { describe, it, expect, vi, afterEach } from "vitest";
import { PinterestDigestService } from "./pinterest-digest-service.js";

function mockChannelManager(connected = true) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    getChannel: vi.fn().mockReturnValue({
      isConnected: () => connected,
      sendMessage,
    }),
    _sendMessage: sendMessage,
  };
}

function mockLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("PinterestDigestService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.PINTEREST_ACCESS_TOKEN;
  });

  it("sends a digest with formatted metrics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            all: {
              summary_metrics: {
                IMPRESSION: 12500,
                PIN_CLICK: 345,
                SAVE: 89,
                ENGAGEMENT: 450,
              },
            },
          }),
      }),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    expect(cm._sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, content] = cm._sendMessage.mock.calls[0];
    expect(chatId).toBe("chat-1");
    expect(content.text).toContain("12.5K");
    expect(content.text).toContain("Pinterest Weekly Digest");
    expect(content.markdown).toBe(true);
    expect(log.info).toHaveBeenCalled();
  });

  it("uses explicit chatId over fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ all: { summary_metrics: {} } }),
      }),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "fallback",
      log,
    });

    await service.sendDigest("explicit-chat");

    expect(cm._sendMessage.mock.calls[0][0]).toBe("explicit-chat");
  });

  it("warns and returns early when no chatId available", async () => {
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";
    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      log,
    });

    await service.sendDigest();

    expect(cm._sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("No chat ID"),
    );
  });

  it("warns and returns early when token missing", async () => {
    delete process.env.PINTEREST_ACCESS_TOKEN;
    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    expect(cm._sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("PINTEREST_ACCESS_TOKEN"),
    );
  });

  it("skips notification when Telegram not connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ all: { summary_metrics: {} } }),
      }),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager(false);
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    expect(cm._sendMessage).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Telegram not connected"),
    );
  });

  it("logs error when Pinterest API returns non-ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    expect(cm._sendMessage).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("500"),
    );
  });

  it("handles fetch exceptions gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network timeout")),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    expect(cm._sendMessage).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining("network timeout"),
    );
  });

  it("formats million-level numbers with M suffix", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            all: { summary_metrics: { IMPRESSION: 2_500_000 } },
          }),
      }),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    const text = cm._sendMessage.mock.calls[0][1].text as string;
    expect(text).toContain("2.5M");
  });

  it("handles missing summary_metrics gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ all: {} }),
      }),
    );
    process.env.PINTEREST_ACCESS_TOKEN = "test-token";

    const cm = mockChannelManager();
    const log = mockLogger();
    const service = new PinterestDigestService({
      channelManager: cm as never,
      fallbackChatId: "chat-1",
      log,
    });

    await service.sendDigest();

    const text = cm._sendMessage.mock.calls[0][1].text as string;
    // Should show 0 for all metrics, not crash
    expect(text).toContain("Impressions: 0");
    expect(text).toContain("Saves: 0");
  });
});
