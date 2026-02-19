import { describe, it, expect, beforeEach } from "vitest";
import { RoomManager } from "./room-manager.js";

describe("RoomManager", () => {
  let rm: RoomManager;

  beforeEach(() => {
    rm = new RoomManager();
  });

  it("creates a room on first join", () => {
    const room = rm.createOrJoin("p1", "s1", "host");
    expect(room.presentationId).toBe("p1");
    expect(room.members.size).toBe(1);
    expect(room.members.get("s1")?.role).toBe("host");
  });

  it("allows a second member to join the same room", () => {
    rm.createOrJoin("p1", "s1", "host");
    const room = rm.createOrJoin("p1", "s2", "guest");
    expect(room.members.size).toBe(2);
  });

  it("removes member on leave and cleans up empty rooms", () => {
    rm.createOrJoin("p1", "s1", "host");
    rm.createOrJoin("p1", "s2", "guest");

    const pid = rm.leave("s1");
    expect(pid).toBe("p1");
    expect(rm.getMemberCount("p1")).toBe(1);

    rm.leave("s2");
    expect(rm.getRoom("p1")).toBeUndefined();
  });

  it("returns null when leaving without a room", () => {
    expect(rm.leave("unknown")).toBeNull();
  });

  it("updates playback state", () => {
    rm.createOrJoin("p1", "s1", "host");
    rm.updatePlayback("p1", { currentTimeSeconds: 42, isPlaying: true });
    const room = rm.getRoom("p1");
    expect(room?.currentTimeSeconds).toBe(42);
    expect(room?.isPlaying).toBe(true);
  });

  it("sets and retrieves FSM state", () => {
    rm.createOrJoin("p1", "s1", "host");
    rm.setFsmState("p1", "PAUSED_USER_Q");
    expect(rm.getRoom("p1")?.fsmState).toBe("PAUSED_USER_Q");
  });

  it("manages peer IDs", () => {
    rm.createOrJoin("p1", "s1", "host");
    rm.createOrJoin("p1", "s2", "guest");

    rm.setPeerId("s1", "peer-1");
    rm.setPeerId("s2", "peer-2");

    const peerIds = rm.getPeerIds("p1");
    expect(peerIds).toContain("peer-1");
    expect(peerIds).toContain("peer-2");
    expect(peerIds).toHaveLength(2);
  });

  it("identifies host correctly", () => {
    rm.createOrJoin("p1", "s1", "host");
    rm.createOrJoin("p1", "s2", "guest");

    expect(rm.isHost("s1")).toBe(true);
    expect(rm.isHost("s2")).toBe(false);
    expect(rm.isHost("unknown")).toBe(false);
  });

  it("removes peer IDs on leave and broadcasts updated list", () => {
    rm.createOrJoin("p1", "s1", "host");
    rm.createOrJoin("p1", "s2", "guest");
    rm.setPeerId("s1", "peer-1");
    rm.setPeerId("s2", "peer-2");

    rm.leave("s2");
    expect(rm.getPeerIds("p1")).toEqual(["peer-1"]);
  });
});
