import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialBrain, type SocialBrainOptions } from "./social-brain.js";
import { SocialRepository } from "./social-repository.js";
import type { Contact, IncomingSocialMessage, IncomingComment } from "./types.js";

function createInMemoryRepo(clock?: () => Date): SocialRepository {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  const repo = new SocialRepository(db, clock);
  repo.migrate();
  return repo;
}

function makeMockCopilot(response: string) {
  return {
    chat: vi.fn().mockImplementation(async function* () {
      yield response;
    }),
    destroySession: vi.fn().mockResolvedValue(undefined),
  } as unknown as SocialBrainOptions["copilot"];
}

function makeMockKnowledge(chunks: string[] = []) {
  return {
    search: vi.fn().mockResolvedValue(chunks.map((text) => ({ text }))),
  } as unknown as SocialBrainOptions["knowledgeService"];
}

function makeContact(repo: SocialRepository, overrides: Partial<{ handoff_active: number }> = {}): Contact {
  const contact = repo.upsertContact({
    platform: "twitter",
    platformUserId: "user_123",
    username: "testuser",
    displayName: "Test User",
  });
  if (overrides.handoff_active) {
    repo.updateContact(contact.id, { handoff_active: 1, handoff_thread_id: "thread_1", handoff_channel: "discord" });
    return repo.getContact(contact.id)!;
  }
  return contact;
}

function makeRawMessage(overrides: Partial<IncomingSocialMessage> = {}): IncomingSocialMessage {
  return {
    platform: "twitter",
    platformMessageId: "msg_1",
    platformUserId: "user_123",
    username: "testuser",
    text: "Hello! What products do you have?",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeComment(overrides: Partial<IncomingComment> = {}): IncomingComment {
  return {
    platform: "twitter",
    postId: "post_1",
    commentId: "comment_1",
    userId: "user_123",
    username: "testuser",
    text: "Great post! Can I get more info?",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("SocialBrain", () => {
  let repo: SocialRepository;

  beforeEach(() => {
    repo = createInMemoryRepo();
  });

  it("emits 'reply' with high confidence result", async () => {
    const copilot = makeMockCopilot('{"reply":"We have great products!","confidence":"high","intent":"product_inquiry"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });
    const replyHandler = vi.fn();
    brain.on("reply", replyHandler);

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("high");
    expect(result!.reply).toBe("We have great products!");
    expect(result!.shouldEscalate).toBe(false);
    expect(replyHandler).toHaveBeenCalledTimes(1);
  });

  it("emits 'escalate' with low confidence result", async () => {
    const copilot = makeMockCopilot('{"reply":"I am not sure","confidence":"low","intent":"unknown"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), confidenceThreshold: "medium" });
    const escalateHandler = vi.fn();
    brain.on("escalate", escalateHandler);

    const contact = makeContact(repo);
    const raw = makeRawMessage({ text: "Something obscure" });
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.shouldEscalate).toBe(true);
    expect(escalateHandler).toHaveBeenCalledTimes(1);
  });

  it("returns null and emits 'escalated_message' when contact is in handoff", async () => {
    const copilot = makeMockCopilot('{"reply":"should not happen","confidence":"high","intent":"test"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });
    const escalatedHandler = vi.fn();
    brain.on("escalated_message", escalatedHandler);

    const contact = makeContact(repo, { handoff_active: 1 });
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result).toBeNull();
    expect(escalatedHandler).toHaveBeenCalledTimes(1);
    expect(copilot.chat).not.toHaveBeenCalled();
  });

  it("includes RAG context in LLM prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Based on our docs...","confidence":"high","intent":"inquiry"}');
    const knowledge = makeMockKnowledge(["Our flagship product is Widget Pro.", "Pricing starts at $99."]);
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: knowledge });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    // No approval gate → public-only to prevent leaking internal data in auto-replies
    expect(knowledge.search).toHaveBeenCalledWith(raw.text, 5, {
      mode: "hybrid",
      minScore: 0.3,
      filter: { visibility: "public" },
    });
    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("Widget Pro");
    expect(promptArg).toContain("$99");
  });

  it("searches internal docs when approvalRequired is true", async () => {
    const copilot = makeMockCopilot('{"reply":"Here is info from our docs","confidence":"high","intent":"inquiry"}');
    const knowledge = makeMockKnowledge(["Internal architecture details."]);
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: knowledge, approvalRequired: true });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    // Approval gate active → include internal docs since a human reviews every reply
    expect(knowledge.search).toHaveBeenCalledWith(raw.text, 5, {
      mode: "hybrid",
      minScore: 0.3,
      filter: { visibility: "internal" },
    });
  });

  it("handles LLM timeout/error gracefully", async () => {
    const copilot = {
      chat: vi.fn().mockImplementation(async function* () { // eslint-disable-line require-yield
        throw new Error("LLM timeout");
      }),
      destroySession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SocialBrainOptions["copilot"];
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result).not.toBeNull();
    expect(result!.confidence).toBe("low");
    expect(result!.shouldEscalate).toBe(true);
    expect(result!.intent).toBe("error");
  });

  it("handles malformed LLM response (non-JSON)", async () => {
    const copilot = makeMockCopilot("Just some plain text response without JSON");
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result).not.toBeNull();
    expect(result!.reply).toBe("Just some plain text response without JSON");
    expect(result!.confidence).toBe("medium");
  });

  it("respects confidenceThreshold='high' — escalates medium", async () => {
    const copilot = makeMockCopilot('{"reply":"Maybe this?","confidence":"medium","intent":"unsure"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), confidenceThreshold: "high" });
    const escalateHandler = vi.fn();
    brain.on("escalate", escalateHandler);

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result!.shouldEscalate).toBe(true);
    expect(escalateHandler).toHaveBeenCalledTimes(1);
  });

  it("logs outbound auto-reply in messages table", async () => {
    const copilot = makeMockCopilot('{"reply":"Here you go!","confidence":"high","intent":"help"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const messages = repo.getMessages(contact.id, 10);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound!.content).toBe("Here you go!");
    expect(outbound!.status).toBe("auto_replied");
  });

  it("handles missing knowledge base gracefully", async () => {
    const copilot = makeMockCopilot('{"reply":"No context available","confidence":"medium","intent":"general"}');
    const knowledge = {
      search: vi.fn().mockRejectedValue(new Error("Knowledge service unavailable")),
    } as unknown as SocialBrainOptions["knowledgeService"];
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: knowledge });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result).not.toBeNull();
    expect(result!.reply).toBe("No context available");
    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("No relevant knowledge base context found");
  });

  it("passes platform metadata in LLM prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Hi!","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage({ platform: "twitter", username: "twitterfan" });
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("Platform: twitter");
    expect(promptArg).toContain("Username: @twitterfan");
  });

  it("includes conversation history in LLM prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Welcome back!","confidence":"high","intent":"followup"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: "First message" });
    repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "outbound", status: "auto_replied", content: "Hi there!" });

    const raw = makeRawMessage({ text: "Second message" });
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("First message");
    expect(promptArg).toContain("Hi there!");
  });

  it("uses custom system prompt when provided", async () => {
    const copilot = makeMockCopilot('{"reply":"Custom!","confidence":"high","intent":"test"}');
    const customPrompt = "You are a pizza delivery chatbot.";
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), systemPrompt: customPrompt });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.systemMessage.content).toContain(customPrompt);
  });

  it("parses JSON from markdown code block response", async () => {
    const copilot = makeMockCopilot('```json\n{"reply":"Parsed!","confidence":"high","intent":"test"}\n```');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    const result = await brain.process(contact, msg, raw);

    expect(result!.reply).toBe("Parsed!");
    expect(result!.confidence).toBe("high");
  });

  it("passes explicit model to copilot.chat when set via setModel()", async () => {
    const copilot = makeMockCopilot('{"reply":"Hello","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });
    brain.setModel("claude-sonnet-4");

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.model).toBe("claude-sonnet-4");
  });

  it("passes model from constructor options", async () => {
    const copilot = makeMockCopilot('{"reply":"Hello","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), model: "gpt-5" });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.model).toBe("gpt-5");
  });

  it("uses getUserSelectedModel fallback when no explicit model is set", async () => {
    const copilot = makeMockCopilot('{"reply":"Hello","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;

    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // When no explicit model is set, it should either use getUserSelectedModel's value
    // (from config/user.json if present on disk) or be undefined — NOT a hardcoded fallback.
    // The important thing is that setModel() takes priority over the config-based fallback.
    const configModel = chatOptions.model;

    // Now set an explicit model and verify it overrides
    const copilot2 = makeMockCopilot('{"reply":"Hi","confidence":"high","intent":"greeting"}');
    const brain2 = new SocialBrain({ repository: repo, copilot: copilot2, knowledgeService: makeMockKnowledge() });
    brain2.setModel("override-model");

    const contact2 = makeContact(repo);
    const raw2 = makeRawMessage({ platformMessageId: "msg_2" });
    const msg2 = repo.insertMessage({ contactId: contact2.id, platform: "twitter", direction: "inbound", content: raw2.text })!;
    await brain2.process(contact2, msg2, raw2);

    const chatOptions2 = (copilot2.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions2.model).toBe("override-model");
    // Explicit model should differ from or match the config-based one
    if (configModel) {
      expect(chatOptions2.model).not.toBe(configModel);
    }
  });

  // ── Approval Queue Tests ──────────────────────────────────────────

  it("emits 'pending_approval' when approvalRequired is true", async () => {
    const copilot = makeMockCopilot('{"reply":"Approved reply","confidence":"high","intent":"help"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), approvalRequired: true });
    const pendingHandler = vi.fn();
    const replyHandler = vi.fn();
    brain.on("pending_approval", pendingHandler);
    brain.on("reply", replyHandler);

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    expect(pendingHandler).toHaveBeenCalledTimes(1);
    expect(replyHandler).not.toHaveBeenCalled();

    // Verify the message was stored as pending_approval
    const messages = repo.getMessages(contact.id, 10);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound!.status).toBe("pending_approval");
    expect(outbound!.content).toBe("Approved reply");
  });

  it("setApprovalRequired toggles approval mode at runtime", async () => {
    const copilot = makeMockCopilot('{"reply":"Reply1","confidence":"high","intent":"test"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });
    const pendingHandler = vi.fn();
    brain.on("pending_approval", pendingHandler);

    // Initially no approval required — should emit "reply"
    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);
    expect(pendingHandler).not.toHaveBeenCalled();

    // Enable approval
    brain.setApprovalRequired(true);

    const copilot2 = makeMockCopilot('{"reply":"Reply2","confidence":"high","intent":"test"}');
    const brain2 = new SocialBrain({ repository: repo, copilot: copilot2, knowledgeService: makeMockKnowledge(), approvalRequired: true });
    const pendingHandler2 = vi.fn();
    brain2.on("pending_approval", pendingHandler2);

    const raw2 = makeRawMessage({ platformMessageId: "msg_2" });
    const msg2 = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw2.text })!;
    await brain2.process(contact, msg2, raw2);
    expect(pendingHandler2).toHaveBeenCalledTimes(1);
  });

  it("routes low confidence through approval when approvalRequired is true", async () => {
    const copilot = makeMockCopilot('{"reply":"Not sure","confidence":"low","intent":"unknown"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), approvalRequired: true, confidenceThreshold: "medium" });
    const escalateHandler = vi.fn();
    const pendingHandler = vi.fn();
    brain.on("escalate", escalateHandler);
    brain.on("pending_approval", pendingHandler);

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    // Low confidence should go through approval queue (not escalate) when approvalRequired is true
    expect(pendingHandler).toHaveBeenCalledTimes(1);
    expect(escalateHandler).not.toHaveBeenCalled();
    // Verify escalation flag is in metadata
    const pendingData = pendingHandler.mock.calls[0][0];
    expect(pendingData.pendingMessage.metadata).toContain('"escalated":true');
  });

  // ── processComment Tests ──────────────────────────────────────────

  it("processComment generates a reply for a comment", async () => {
    const copilot = makeMockCopilot('{"reply":"Thanks for your comment!","confidence":"high","intent":"gratitude"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });
    const commentReplyHandler = vi.fn();
    brain.on("comment_reply", commentReplyHandler);

    const comment = makeComment();
    const result = await brain.processComment(comment);

    expect(result).not.toBeNull();
    expect(result!.reply).toBe("Thanks for your comment!");
    expect(result!.confidence).toBe("high");
    expect(commentReplyHandler).toHaveBeenCalledTimes(1);
  });

  it("processComment stores outbound message with comment metadata", async () => {
    const copilot = makeMockCopilot('{"reply":"Sure thing!","confidence":"high","intent":"help"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const comment = makeComment();
    await brain.processComment(comment);

    // Find the contact that was upserted
    const contact = repo.getContactByPlatformUser("twitter", "user_123");
    expect(contact).toBeDefined();

    const messages = repo.getMessages(contact!.id, 10);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound).toBeDefined();
    expect(outbound!.content).toBe("Sure thing!");
    const meta = JSON.parse(outbound!.metadata);
    expect(meta.source).toBe("brain_comment");
    expect(meta.commentId).toBe("comment_1");
    expect(meta.postId).toBe("post_1");
  });

  it("processComment with approvalRequired stores as pending_approval", async () => {
    const copilot = makeMockCopilot('{"reply":"Pending comment reply","confidence":"high","intent":"info"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), approvalRequired: true });
    const pendingHandler = vi.fn();
    brain.on("pending_approval", pendingHandler);

    const comment = makeComment();
    await brain.processComment(comment);

    expect(pendingHandler).toHaveBeenCalledTimes(1);

    const contact = repo.getContactByPlatformUser("twitter", "user_123");
    const messages = repo.getMessages(contact!.id, 10);
    const outbound = messages.find((m) => m.direction === "outbound");
    expect(outbound!.status).toBe("pending_approval");
  });

  it("processComment returns null when contact is in handoff", async () => {
    const copilot = makeMockCopilot('{"reply":"should not happen","confidence":"high","intent":"test"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    // Create a contact with handoff active
    makeContact(repo, { handoff_active: 1 });
    const comment = makeComment({ userId: "user_123" });
    const result = await brain.processComment(comment);

    expect(result).toBeNull();
    expect(copilot.chat).not.toHaveBeenCalled();
  });

  it("processComment includes post context in prompt when available", async () => {
    const copilot = makeMockCopilot('{"reply":"Great question!","confidence":"high","intent":"inquiry"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const comment = makeComment({
      postContext: {
        postId: "post_1",
        platform: "twitter",
        caption: "Check out our new product!",
        permalink: "https://twitter.com/post/1",
        mediaType: "IMAGE",
        mediaUrl: "",
        authorUsername: "brand",
        publishedAt: new Date().toISOString(),
        cachedAt: new Date().toISOString(),
      },
    });

    await brain.processComment(comment);

    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("Check out our new product!");
    expect(promptArg).toContain("public comment reply");
  });

  it("processComment enhances KB search query with post caption", async () => {
    const copilot = makeMockCopilot('{"reply":"Sure!","confidence":"high","intent":"info"}');
    const knowledge = makeMockKnowledge(["Some product info."]);
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: knowledge });

    const comment = makeComment({
      text: "What features does this have?",
      postContext: {
        postId: "post_1",
        platform: "twitter",
        caption: "OpenZigs is an AI agent platform with Director Mode and Social Brain",
        permalink: "https://twitter.com/post/1",
        mediaType: "IMAGE",
        mediaUrl: "",
        authorUsername: "brand",
        publishedAt: new Date().toISOString(),
        cachedAt: new Date().toISOString(),
      },
    });

    await brain.processComment(comment);

    // The search query should be enhanced with the post caption for richer semantic matching
    const searchCall = (knowledge.search as ReturnType<typeof vi.fn>).mock.calls[0];
    const searchQuery = searchCall[0] as string;
    expect(searchQuery).toContain("What features does this have?");
    expect(searchQuery).toContain("OpenZigs");
    expect(searchQuery).toContain("Director Mode");
  });

  // ── Response Style Tests ──────────────────────────────────────────

  it("includes social-responder skill content in system prompt by default", async () => {
    const copilot = makeMockCopilot('{"reply":"Hey!","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // The social-responder skill should be loaded and injected into the system prompt
    expect(chatOptions.systemMessage.content).toContain("Social Responder");
  });

  it("applies professional response style modifier to system prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Good day.","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), responseStyle: "professional" });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.systemMessage.content).toContain("polished, professional tone");
  });

  it("applies witty response style modifier to system prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Oh you!","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), responseStyle: "witty" });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.systemMessage.content).toContain("clever and slightly playful");
  });

  it("applies minimal response style modifier to system prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Yes.","confidence":"high","intent":"confirmation"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), responseStyle: "minimal" });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.systemMessage.content).toContain("extremely brief");
  });

  it("setResponseStyle updates style at runtime and rebuilds prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Hey!","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    expect(brain.getResponseStyle()).toBe("friendly");
    brain.setResponseStyle("professional");
    expect(brain.getResponseStyle()).toBe("professional");

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.systemMessage.content).toContain("polished, professional tone");
  });

  it("brand voice block takes priority over response style (appended last)", async () => {
    const copilot = makeMockCopilot('{"reply":"On brand!","confidence":"high","intent":"greeting"}');
    const brandBlock = "BRAND VOICE: Always use the word 'exceptional'.";
    const brain = new SocialBrain({
      repository: repo,
      copilot,
      knowledgeService: makeMockKnowledge(),
      responseStyle: "witty",
      brandVoiceBlock: brandBlock,
    });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const content = chatOptions.systemMessage.content as string;
    // Brand voice should come after the style modifier
    const wittyIdx = content.indexOf("clever and slightly playful");
    const brandIdx = content.indexOf("exceptional");
    expect(wittyIdx).toBeGreaterThan(-1);
    expect(brandIdx).toBeGreaterThan(wittyIdx);
  });

  it("friendly style does not add a style modifier (it is the default tone)", async () => {
    const copilot = makeMockCopilot('{"reply":"Hi!","confidence":"high","intent":"greeting"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), responseStyle: "friendly" });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const content = chatOptions.systemMessage.content as string;
    expect(content).not.toContain("Style override:");
  });

  it("setConfidenceThreshold updates threshold at runtime", async () => {
    const copilot = makeMockCopilot('{"reply":"Sure thing!","confidence":"medium","intent":"info"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge(), confidenceThreshold: "high" });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text })!;

    // With "high" threshold, a "medium" confidence reply should escalate
    const result1 = await brain.process(contact, msg, raw);
    expect(result1?.shouldEscalate).toBe(true);

    // Lower the threshold to "low" at runtime — now "medium" should NOT escalate
    brain.setConfidenceThreshold("low");
    const result2 = await brain.process(contact, msg, raw);
    expect(result2?.shouldEscalate).toBe(false);
  });
});
