
import { describe, it, expect, vi } from "vitest";
import { MessageRouter } from "./message-router.js";
import { ChannelManager } from "../channels/channel-manager.js";
import { SessionManager } from "../sessions/session-manager.js";
import { CopilotWrapperService } from "../copilot/copilot-wrapper.js";

describe("MessageRouter Access Control", () => {
  it("should block unauthorized users in allowlist mode", async () => {
    // 1. Setup mocks
    const mockChannel = {
      type: "telegram",
      sendMessage: vi.fn(),
      onMessage: vi.fn(),
      onApprovalResponse: vi.fn(),
      sendApprovalRequest: vi.fn()
    };
    
    const mockChannelManager = {
      getChannel: () => mockChannel
    } as unknown as ChannelManager;

    const mockSessionManager = {
      // If code reaches here, it was allowed
      listSessions: vi.fn(), 
      createSession: vi.fn()
    } as unknown as SessionManager;

    const mockCopilot = {} as unknown as CopilotWrapperService;

    // 2. Initialize Router with Allowlist
    const router = new MessageRouter({
      channelManager: mockChannelManager,
      sessionManager: mockSessionManager,
      copilot: mockCopilot,
      accessControl: {
        mode: "allowlist",
        allowedUsers: ["telegram:12345"], // Only ID 12345 is allowed
        blockedUsers: []
      }
    });

    // 3. Simulate Message from UNKNOWN user (99999)
    await router.route({
      channelType: "telegram",
      channelId: "telegram",
      chatId: "chat_999",
      userId: "99999", 
      username: "hacker",
      content: "hello",
      attachments: [],
      timestamp: new Date()
    });

    // 4. Assertions
    // Expect "Unauthorized" message sent
    expect(mockChannel.sendMessage).toHaveBeenCalledWith("chat_999", { text: "Unauthorized" });
    // Expect Session Manager NOT called
    expect(mockSessionManager.listSessions).not.toHaveBeenCalled();
  });

  it("should allow listed users in allowlist mode", async () => {
    // 1. Setup mocks
    const mockChannel = {
        type: "telegram",
        sendMessage: vi.fn(),
        onMessage: vi.fn(),
        onApprovalResponse: vi.fn(),
        sendApprovalRequest: vi.fn()
    };
    const mockChannelManager = { getChannel: () => mockChannel } as unknown as ChannelManager;

    const mockSessionManager = {
        listSessions: vi.fn().mockResolvedValue([]), // Return empty to trigger createSession
        createSession: vi.fn().mockResolvedValue({ id: "sess_1" }),
        resumeSession: vi.fn().mockResolvedValue({ history: [] }),
        appendEvent: vi.fn()
    } as unknown as SessionManager;

    const mockCopilot = {
        chat: async function* () { yield "response"; } // Mock generator
    } as unknown as CopilotWrapperService;

    // 2. Initialize Router
    const router = new MessageRouter({
      channelManager: mockChannelManager,
      sessionManager: mockSessionManager,
      copilot: mockCopilot,
      accessControl: {
        mode: "allowlist",
        allowedUsers: ["telegram:12345"], 
        blockedUsers: []
      }
    });

    // 3. Simulate Message from ALLOWED user (12345)
    await router.route({
      channelType: "telegram",
      channelId: "telegram",
      chatId: "chat_123",
      userId: "12345", 
      username: "vip_user",
      content: "hi",
      attachments: [],
      timestamp: new Date()
    });

    // 4. Assertions
    // Should NOT send "Unauthorized" (sendMessage called with real response instead)
    expect(mockChannel.sendMessage).toHaveBeenCalledWith("chat_123", { text: "response" });
    // Should verify session was created
    expect(mockSessionManager.createSession).toHaveBeenCalled();
  });
});
