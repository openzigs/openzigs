import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SocialBrain, type SocialBrainOptions } from "./social-brain.js";
import { SocialRepository } from "./social-repository.js";
import type { Contact, IncomingSocialMessage } from "./types.js";

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
    platform: "instagram",
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
    platform: "instagram",
    platformMessageId: "msg_1",
    platformUserId: "user_123",
    username: "testuser",
    text: "Hello! What products do you have?",
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
    await brain.process(contact, msg, raw);

    expect(knowledge.search).toHaveBeenCalledWith(raw.text, 5, { mode: "hybrid" });
    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("Widget Pro");
    expect(promptArg).toContain("$99");
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
    const result = await brain.process(contact, msg, raw);

    expect(result!.shouldEscalate).toBe(true);
    expect(escalateHandler).toHaveBeenCalledTimes(1);
  });

  it("logs outbound auto-reply in messages table", async () => {
    const copilot = makeMockCopilot('{"reply":"Here you go!","confidence":"high","intent":"help"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "twitter", direction: "inbound", content: raw.text });
    await brain.process(contact, msg, raw);

    const promptArg = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(promptArg).toContain("Platform: twitter");
    expect(promptArg).toContain("Username: @twitterfan");
  });

  it("includes conversation history in LLM prompt", async () => {
    const copilot = makeMockCopilot('{"reply":"Welcome back!","confidence":"high","intent":"followup"}');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: "First message" });
    repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "outbound", status: "auto_replied", content: "Hi there!" });

    const raw = makeRawMessage({ text: "Second message" });
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
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
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
    await brain.process(contact, msg, raw);

    const chatOptions = (copilot.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(chatOptions.systemMessage.content).toBe(customPrompt);
  });

  it("parses JSON from markdown code block response", async () => {
    const copilot = makeMockCopilot('```json\n{"reply":"Parsed!","confidence":"high","intent":"test"}\n```');
    const brain = new SocialBrain({ repository: repo, copilot, knowledgeService: makeMockKnowledge() });

    const contact = makeContact(repo);
    const raw = makeRawMessage();
    const msg = repo.insertMessage({ contactId: contact.id, platform: "instagram", direction: "inbound", content: raw.text });
    const result = await brain.process(contact, msg, raw);

    expect(result!.reply).toBe("Parsed!");
    expect(result!.confidence).toBe("high");
  });
});
