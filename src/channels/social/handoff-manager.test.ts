import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { HandoffManager, type HandoffChannel } from "./handoff-manager.js";
import { SocialRepository } from "./social-repository.js";
import type { Contact, EscalationContext, IncomingSocialMessage } from "./types.js";

function createInMemoryRepo(): SocialRepository {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new SocialRepository(db);
  repo.migrate();
  return repo;
}

function makeContact(repo: SocialRepository, overrides: Partial<{ handoff: boolean }> = {}): Contact {
  const contact = repo.upsertContact({
    platform: "instagram",
    platformUserId: "user_1",
    username: "testuser",
    displayName: "Test User",
  });
  if (overrides.handoff) {
    repo.updateContact(contact.id, { handoff_active: 1, handoff_thread_id: "thread_1", handoff_channel: "discord" });
    return repo.getContact(contact.id)!;
  }
  return contact;
}

function makeEscalationContext(overrides: Partial<EscalationContext> = {}): EscalationContext {
  return {
    brainConfidence: "low",
    brainIntent: "unknown",
    ragChunksUsed: ["Some context about product"],
    conversationHistory: [],
    triggerReason: "low_confidence",
    ...overrides,
  };
}

function makeRawMessage(overrides: Partial<IncomingSocialMessage> = {}): IncomingSocialMessage {
  return {
    platform: "instagram",
    platformMessageId: "msg_1",
    platformUserId: "user_1",
    username: "testuser",
    text: "I need help with my order",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockChannel(type: "discord" | "telegram" = "discord"): HandoffChannel & { createThread: ReturnType<typeof vi.fn>; postToThread: ReturnType<typeof vi.fn>; archiveThread: ReturnType<typeof vi.fn> } {
  return {
    type,
    createThread: vi.fn().mockResolvedValue("thread_new_123"),
    postToThread: vi.fn().mockResolvedValue(undefined),
    archiveThread: vi.fn().mockResolvedValue(undefined),
  };
}

describe("HandoffManager", () => {
  let repo: SocialRepository;
  let discordChannel: ReturnType<typeof makeMockChannel>;
  let manager: HandoffManager;

  beforeEach(() => {
    repo = createInMemoryRepo();
    discordChannel = makeMockChannel("discord");
    manager = new HandoffManager({
      repository: repo,
      handoffChannels: [discordChannel],
      preferredChannel: "discord",
    });
  });

  it("creates a support thread on escalation", async () => {
    const contact = makeContact(repo);
    const context = makeEscalationContext();
    const raw = makeRawMessage();

    const session = await manager.escalate(contact, context, raw);

    expect(session).not.toBeNull();
    expect(session!.channel).toBe("discord");
    expect(session!.threadId).toBe("thread_new_123");
    expect(discordChannel.createThread).toHaveBeenCalledTimes(1);
    expect(discordChannel.createThread).toHaveBeenCalledWith(
      expect.stringContaining("Test User"),
      expect.stringContaining("I need help with my order"),
    );
  });

  it("updates CRM with handoff state after escalation", async () => {
    const contact = makeContact(repo);
    const context = makeEscalationContext();
    const raw = makeRawMessage();

    await manager.escalate(contact, context, raw);

    const updated = repo.getContact(contact.id)!;
    expect(updated.handoff_active).toBe(1);
    expect(updated.handoff_thread_id).toBe("thread_new_123");
    expect(updated.handoff_channel).toBe("discord");
    const tags = JSON.parse(updated.tags);
    expect(tags).toContain("handoff-active");
  });

  it("emits 'escalated' event with session details", async () => {
    const handler = vi.fn();
    manager.on("escalated", handler);

    const contact = makeContact(repo);
    await manager.escalate(contact, makeEscalationContext(), makeRawMessage());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "discord", threadId: "thread_new_123" }),
    );
  });

  it("forwards user messages to existing handoff thread", async () => {
    const contact = makeContact(repo, { handoff: true });
    await manager.forwardToThread(contact, "Please help me!");

    expect(discordChannel.postToThread).toHaveBeenCalledWith(
      "thread_1",
      expect.stringContaining("Please help me!"),
    );
  });

  it("returns null when no channel is registered for escalation", async () => {
    const noChannelManager = new HandoffManager({
      repository: repo,
      handoffChannels: [],
      preferredChannel: "telegram",
    });
    const contact = makeContact(repo);
    const session = await noChannelManager.escalate(contact, makeEscalationContext(), makeRawMessage());

    expect(session).toBeNull();
  });

  it("routes admin reply back to contact", async () => {
    const contact = makeContact(repo);
    await manager.escalate(contact, makeEscalationContext(), makeRawMessage());

    const reply = manager.handleAdminReply("thread_new_123", "We will fix your order.");
    expect(reply).not.toBeNull();
    expect(reply!.contactId).toBe(contact.id);
    expect(reply!.message).toBe("We will fix your order.");

    const messages = repo.getMessages(contact.id, 10);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound!.content).toBe("We will fix your order.");
  });

  it("closes handoff and archives thread", async () => {
    const contact = makeContact(repo);
    await manager.escalate(contact, makeEscalationContext(), makeRawMessage());

    const closed = await manager.closeHandoff(contact.id, "Issue resolved");

    expect(closed).toBe(true);
    expect(discordChannel.archiveThread).toHaveBeenCalledWith("thread_new_123");
    const updated = repo.getContact(contact.id)!;
    expect(updated.handoff_active).toBe(0);
    expect(updated.handoff_thread_id).toBeNull();
    const tags = JSON.parse(updated.tags);
    expect(tags).not.toContain("handoff-active");
    expect(tags.some((t: string) => t.startsWith("handoff-resolved-"))).toBe(true);
  });

  it("emits 'resolved' event when handoff is closed", async () => {
    const handler = vi.fn();
    manager.on("resolved", handler);

    const contact = makeContact(repo);
    await manager.escalate(contact, makeEscalationContext(), makeRawMessage());
    await manager.closeHandoff(contact.id, "Done");

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: contact.id, resolution: "Done" }),
    );
  });

  it("returns false when closing handoff for non-active contact", async () => {
    const contact = makeContact(repo);
    const closed = await manager.closeHandoff(contact.id);
    expect(closed).toBe(false);
  });

  it("includes RAG context in escalation thread message", async () => {
    const contact = makeContact(repo);
    const context = makeEscalationContext({ ragChunksUsed: ["Product FAQ: Returns are accepted within 30 days"] });
    const raw = makeRawMessage();

    await manager.escalate(contact, context, raw);

    expect(discordChannel.createThread).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Returns are accepted within 30 days"),
    );
  });

  it("handleAdminReply returns null for unknown thread", () => {
    const reply = manager.handleAdminReply("unknown_thread_999", "Hello?");
    expect(reply).toBeNull();
  });
});
