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
});
