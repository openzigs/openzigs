import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { WebChatChannel } from "./web-chat.js";
import type { IncomingMessage, ApprovalResponse } from "./types.js";

class FakeSocket extends EventEmitter {
  readonly id: string;
  readonly handshake: { query: Record<string, string> };
  emitted: Array<{ event: string; data: unknown }> = [];

  constructor(id: string, query: Record<string, string> = {}) {
    super();
    this.id = id;
    this.handshake = { query };
  }

  emit(event: string, ...args: unknown[]): boolean {
    this.emitted.push({ event, data: args[0] });
    return super.emit(event, ...args);
  }
}

class FakeIOServer extends EventEmitter {
  sockets: FakeSocket[] = [];

  simulateConnection(socketId = "socket-1", query: Record<string, string> = {}): FakeSocket {
    const socket = new FakeSocket(socketId, query);
    this.sockets.push(socket);
    this.emit("connection", socket);
    return socket;
  }
}

describe("WebChatChannel", () => {
  let io: FakeIOServer;
  let channel: WebChatChannel;

  afterEach(async () => {
    if (channel?.isConnected()) {
      await channel.disconnect();
    }
  });

  const setup = async () => {
    io = new FakeIOServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel = new WebChatChannel({ io: io as any });
    await channel.connect();
    return { io, channel };
  };

  it("tracks connection state", async () => {
    await setup();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  it("assigns a chatId on connection and emits chat:connected", async () => {
    await setup();
    const socket = io.simulateConnection("sock-1");
    const connected = socket.emitted.find((e) => e.event === "chat:connected");
    expect(connected).toBeDefined();
    expect((connected?.data as { chatId: string }).chatId).toBeTruthy();
  });

  it("receives chat:message and fires onMessage handler", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-2");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    socket.emit("chat:message", { content: "Hello world" });

    expect(received).toHaveLength(1);
    expect(received[0].content).toBe("Hello world");
    expect(received[0].channelType).toBe("web");
    expect(received[0].chatId).toBe(chatId);
  });

  it("ignores empty chat:message content", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-3");
    socket.emit("chat:message", { content: "" });
    socket.emit("chat:message", { content: "   " });
    socket.emit("chat:message", {});

    expect(received).toHaveLength(0);
  });

  it("sends message to the correct socket via chatId", async () => {
    await setup();
    const socket = io.simulateConnection("sock-4");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    await channel.sendMessage(chatId, { text: "Reply text" });

    const response = socket.emitted.find((e) => e.event === "chat:response");
    expect(response).toBeDefined();
    expect((response?.data as { content: string }).content).toBe("Reply text");
  });

  it("sends stream chunks and stream end", async () => {
    await setup();
    const socket = io.simulateConnection("sock-5");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    await channel.sendStreamChunk(chatId, "Hello ", "msg-1");
    await channel.sendStreamChunk(chatId, "world", "msg-1");
    await channel.sendStreamEnd(chatId, "msg-1");

    const streamEvents = socket.emitted.filter((e) => e.event === "chat:stream");
    expect(streamEvents).toHaveLength(2);
    expect((streamEvents[0].data as { chunk: string }).chunk).toBe("Hello ");
    expect((streamEvents[1].data as { chunk: string }).chunk).toBe("world");

    const endEvents = socket.emitted.filter((e) => e.event === "chat:stream:end");
    expect(endEvents).toHaveLength(1);
  });

  it("sends errors to the client", async () => {
    await setup();
    const socket = io.simulateConnection("sock-6");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    await channel.sendError(chatId, "Something broke");

    const errorEvent = socket.emitted.find((e) => e.event === "chat:error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as { error: string }).error).toBe("Something broke");
  });

  it("handles approval response from client", async () => {
    await setup();
    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((r) => responses.push(r));

    const socket = io.simulateConnection("sock-7");
    socket.emit("approval:response", { approvalId: "appr-1", approved: true });

    expect(responses).toHaveLength(1);
    expect(responses[0].approvalId).toBe("appr-1");
    expect(responses[0].approved).toBe(true);
  });

  it("ignores malformed approval responses", async () => {
    await setup();
    const responses: ApprovalResponse[] = [];
    channel.onApprovalResponse((r) => responses.push(r));

    const socket = io.simulateConnection("sock-8");
    socket.emit("approval:response", { approvalId: 123 });
    socket.emit("approval:response", {});
    socket.emit("approval:response", null);

    expect(responses).toHaveLength(0);
  });

  it("cleans up on socket disconnect", async () => {
    await setup();
    const socket = io.simulateConnection("sock-9");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    socket.emit("disconnect");

    // After disconnect, sending should silently fail (no socket found)
    await channel.sendMessage(chatId, { text: "Ghost" });
    // No error thrown, message just not delivered — socket is gone
    const responses = socket.emitted.filter((e) => e.event === "chat:response");
    expect(responses).toHaveLength(0);
  });

  it("uses stable userId when clientId is provided in handshake", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-stable", { clientId: "my-stable-id" });
    socket.emit("chat:message", { content: "Hello" });

    expect(received).toHaveLength(1);
    expect(received[0].userId).toBe("web:my-stable-id");
  });

  it("falls back to chatId-based userId when no clientId", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-fallback");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;
    socket.emit("chat:message", { content: "Hi" });

    expect(received).toHaveLength(1);
    expect(received[0].userId).toBe(`web:${chatId}`);
  });

  it("throws when sending on a disconnected channel", async () => {
    await setup();
    await channel.disconnect();

    await expect(channel.sendMessage("c1", { text: "x" })).rejects.toThrow("Channel is not connected");
  });

  // ── New tests ──

  it("sends tool progress events", async () => {
    await setup();
    const socket = io.simulateConnection("sock-tool");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    await channel.sendToolProgress(chatId, "shell-execute");

    const toolEvent = socket.emitted.find((e) => e.event === "chat:tool_call");
    expect(toolEvent).toBeDefined();
    expect((toolEvent?.data as { tool: string }).tool).toBe("shell-execute");
  });

  it("sends approval request to socket", async () => {
    await setup();
    const socket = io.simulateConnection("sock-appr");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    await channel.sendApprovalRequest(chatId, {
      id: "appr-1",
      tool: "write-file",
      args: { path: "/tmp/x" },
      riskLevel: "medium",
      explanation: "Writing a file",
    });

    const apprEvent = socket.emitted.find((e) => e.event === "approval:request");
    expect(apprEvent).toBeDefined();
    expect((apprEvent?.data as { id: string }).id).toBe("appr-1");
  });

  it("throws when sending approval request on disconnected channel", async () => {
    await setup();
    await channel.disconnect();

    await expect(channel.sendApprovalRequest("c1", {
      id: "a1", tool: "test", args: {}, riskLevel: "medium", explanation: "test",
    })).rejects.toThrow("Channel is not connected");
  });

  it("sendMessage is no-op for unknown chatId", async () => {
    await setup();
    // Sending to a chatId with no connected socket should be silently ignored
    await channel.sendMessage("unknown-chat-id", { text: "hello" });
    // No error thrown
  });

  it("sendStreamChunk is no-op for unknown chatId", async () => {
    await setup();
    await channel.sendStreamChunk("unknown-chat-id", "chunk", "msg-1");
    // No error thrown
  });

  it("sendStreamEnd is no-op for unknown chatId", async () => {
    await setup();
    await channel.sendStreamEnd("unknown-chat-id", "msg-1");
    // No error thrown
  });

  it("sendError is no-op for unknown chatId", async () => {
    await setup();
    await channel.sendError("unknown-chat-id", "error");
    // No error thrown
  });

  it("sendToolProgress is no-op for unknown chatId", async () => {
    await setup();
    await channel.sendToolProgress("unknown-chat-id", "tool");
    // No error thrown
  });

  it("rejects messages exceeding max length", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-long");
    socket.emit("chat:message", { content: "x".repeat(10_001) });

    expect(received).toHaveLength(0);
    const errorEvent = socket.emitted.find((e) => e.event === "chat:error");
    expect(errorEvent).toBeDefined();
  });

  it("passes model and tools from chat:message data", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-model");
    socket.emit("chat:message", { content: "hi", model: "gpt-4.1", tools: ["read-file"] });

    expect(received).toHaveLength(1);
    expect(received[0].model).toBe("gpt-4.1");
    expect(received[0].tools).toEqual(["read-file"]);
  });

  it("passes workingDirectory from chat:message data", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-wd");
    socket.emit("chat:message", { content: "hi", workingDirectory: "/tmp/project" });

    expect(received).toHaveLength(1);
    expect(received[0].workingDirectory).toBe("/tmp/project");
  });

  it("handles user_input_response for pending request", async () => {
    await setup();
    const socket = io.simulateConnection("sock-input");
    const chatId = (socket.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;

    // Send user input request
    const responsePromise = channel.sendUserInputRequest(chatId, {
      question: "Pick a color",
      choices: ["red", "blue"],
    });

    // Find the emitted request and get its requestId
    const inputReq = socket.emitted.find((e) => e.event === "user_input_request");
    expect(inputReq).toBeDefined();
    const requestId = (inputReq?.data as { requestId: string }).requestId;

    // Respond
    socket.emit("user_input_response", { requestId, answer: "blue", wasFreeform: false });

    const result = await responsePromise;
    expect(result.answer).toBe("blue");
    expect(result.wasFreeform).toBe(false);
  });

  it("sendUserInputRequest returns empty response for unknown chatId", async () => {
    await setup();
    const result = await channel.sendUserInputRequest("unknown-chat", {
      question: "hello",
    });
    expect(result.answer).toBe("");
  });

  it("user_input_response with no matching pending request is ignored", async () => {
    await setup();
    const socket = io.simulateConnection("sock-orphan");
    // No pending request, just fire a response — should not throw
    socket.emit("user_input_response", { requestId: "nonexistent", answer: "hi" });
  });

  it("user_input_response with empty requestId is ignored", async () => {
    await setup();
    const socket = io.simulateConnection("sock-empty-req");
    socket.emit("user_input_response", { answer: "hi" });
    // No error thrown
  });

  it("chat:request-session re-emits chat:connected", async () => {
    await setup();
    const socket = io.simulateConnection("sock-resession");
    const initialConnected = socket.emitted.filter((e) => e.event === "chat:connected");
    expect(initialConnected).toHaveLength(1);

    socket.emit("chat:request-session");

    const allConnected = socket.emitted.filter((e) => e.event === "chat:connected");
    expect(allConnected).toHaveLength(2);
  });

  it("onClear handler is called during chat:clear", async () => {
    const mockSessionManager = {
      listSessions: async () => [{ id: "s1", metadata: {} }],
      clearSession: async () => {},
      getHistory: async () => [],
    };
    io = new FakeIOServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    channel = new WebChatChannel({ io: io as any, sessionManager: mockSessionManager as any });
    await channel.connect();

    const cleared: Array<{ userId: string }> = [];
    channel.onClear((data) => cleared.push(data));

    const socket = io.simulateConnection("sock-clear", { clientId: "clear-user" });
    socket.emit("chat:clear");

    // Wait for async clear to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(cleared).toHaveLength(1);
    expect(cleared[0].userId).toBe("web:clear-user");
  });

  it("has correct id and type", async () => {
    await setup();
    expect(channel.id).toBe("web-chat");
    expect(channel.type).toBe("web");
  });

  it("multiple sockets get different chatIds", async () => {
    await setup();
    const s1 = io.simulateConnection("sock-a");
    const s2 = io.simulateConnection("sock-b");
    const chatId1 = (s1.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;
    const chatId2 = (s2.emitted.find((e) => e.event === "chat:connected")?.data as { chatId: string }).chatId;
    expect(chatId1).not.toBe(chatId2);
  });

  it("files are passed through from chat:message", async () => {
    await setup();
    const received: IncomingMessage[] = [];
    channel.onMessage((msg) => received.push(msg));

    const socket = io.simulateConnection("sock-files");
    const files = [{ type: "file" as const, path: "/tmp/test.ts" }];
    socket.emit("chat:message", { content: "check this", files });

    expect(received).toHaveLength(1);
    expect(received[0].files).toEqual(files);
  });
});
