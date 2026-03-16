import { describe, it, expect, vi, beforeEach } from "vitest";
import { FollowerWelcomeService } from "./follower-welcome.js";

describe("FollowerWelcomeService", () => {
  let welcome: FollowerWelcomeService;
  let sendDm: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sendDm = vi.fn().mockResolvedValue(undefined);
    welcome = new FollowerWelcomeService({
      sendDm,
      config: {
        enabled: true,
        delaySeconds: 0,
        messages: {
          twitter: "Hey {{username}}, welcome to our community!",
          reddit: "Hello {{username}}, thanks for following us!",
        },
      },
    });
  });

  it("sends welcome DM to new followers", async () => {
    welcome.handleNewFollower("twitter", "u_1", "alice");
    // Give the async send a tick
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    expect(sendDm).toHaveBeenCalledWith("twitter", "u_1", "Hey alice, welcome to our community!");
  });

  it("interpolates username in welcome message", async () => {
    welcome.handleNewFollower("reddit", "u_2", "bob_coder");
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    expect(sendDm).toHaveBeenCalledWith("reddit", "u_2", "Hello bob_coder, thanks for following us!");
  });

  it("does not send when disabled", () => {
    welcome.setEnabled(false);
    welcome.handleNewFollower("twitter", "u_3", "charlie");
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("does not send for platforms without configured message", () => {
    welcome.handleNewFollower("youtube", "u_4", "dave");
    expect(sendDm).not.toHaveBeenCalled();
  });

  it("prevents duplicate welcome DMs to same user", async () => {
    welcome.handleNewFollower("twitter", "u_5", "eve");
    welcome.handleNewFollower("twitter", "u_5", "eve");
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    expect(sendDm).toHaveBeenCalledTimes(1);
  });

  it("emits welcome_sent event on success", async () => {
    const handler = vi.fn();
    welcome.on("welcome_sent", handler);

    welcome.handleNewFollower("twitter", "u_6", "frank");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0]).toMatchObject({
      platform: "twitter",
      userId: "u_6",
      username: "frank",
    });
  });

  it("emits welcome_error on send failure", async () => {
    sendDm.mockRejectedValue(new Error("DM blocked"));
    const handler = vi.fn();
    welcome.on("welcome_error", handler);

    welcome.handleNewFollower("twitter", "u_7", "grace");
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler.mock.calls[0][0].error).toBe("DM blocked");
  });

  it("allows setting message at runtime", async () => {
    welcome.setMessage("tiktok", "Welcome to TikTok, {{username}}!");
    welcome.handleNewFollower("tiktok", "u_8", "heidi");
    await vi.waitFor(() => expect(sendDm).toHaveBeenCalledTimes(1));
    expect(sendDm).toHaveBeenCalledWith("tiktok", "u_8", "Welcome to TikTok, heidi!");
  });

  it("does not send when no sendDm configured", () => {
    const noSend = new FollowerWelcomeService({
      config: { enabled: true, delaySeconds: 0, messages: { twitter: "Hi!" } },
    });
    noSend.handleNewFollower("twitter", "u_9", "ivan");
    // Should not throw
  });
});
