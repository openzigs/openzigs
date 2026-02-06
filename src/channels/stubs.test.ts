import { describe, expect, it } from "vitest";
import { WebChannel } from "./stubs.js";

describe("Channel stubs", () => {
  it("tracks connection state", async () => {
    const channel = new WebChannel();
    expect(channel.isConnected()).toBe(false);
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });
});
