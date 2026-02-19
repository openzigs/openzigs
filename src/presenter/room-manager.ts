/**
 * Room Manager — Ephemeral in-memory room state for multiplayer Presenter Mode.
 * Issue #284: Rooms evaporate on server restart. No database.
 */

export type RoomMember = {
  socketId: string;
  role: "host" | "guest";
  peerId?: string;
  joinedAt: Date;
};

export type FsmState = "PLAYING" | "PAUSED_USER_Q" | "PAUSED_QUIZ";

export type RoomState = {
  presentationId: string;
  currentTimeSeconds: number;
  isPlaying: boolean;
  fsmState: FsmState;
  members: Map<string, RoomMember>;
};

export class RoomManager {
  private rooms = new Map<string, RoomState>();
  /** Reverse index: socketId → presentationId for fast disconnect cleanup */
  private socketToRoom = new Map<string, string>();

  createOrJoin(presentationId: string, socketId: string, role: "host" | "guest"): RoomState {
    let room = this.rooms.get(presentationId);
    if (!room) {
      room = {
        presentationId,
        currentTimeSeconds: 0,
        isPlaying: false,
        fsmState: "PLAYING",
        members: new Map(),
      };
      this.rooms.set(presentationId, room);
    }

    room.members.set(socketId, {
      socketId,
      role,
      joinedAt: new Date(),
    });
    this.socketToRoom.set(socketId, presentationId);

    return room;
  }

  leave(socketId: string): string | null {
    const presentationId = this.socketToRoom.get(socketId);
    if (!presentationId) return null;

    this.socketToRoom.delete(socketId);
    const room = this.rooms.get(presentationId);
    if (room) {
      room.members.delete(socketId);
      if (room.members.size === 0) {
        this.rooms.delete(presentationId);
      }
    }

    return presentationId;
  }

  updatePlayback(presentationId: string, patch: Partial<Pick<RoomState, "currentTimeSeconds" | "isPlaying">>): void {
    const room = this.rooms.get(presentationId);
    if (!room) return;
    if (patch.currentTimeSeconds !== undefined) room.currentTimeSeconds = patch.currentTimeSeconds;
    if (patch.isPlaying !== undefined) room.isPlaying = patch.isPlaying;
  }

  setFsmState(presentationId: string, fsmState: FsmState): void {
    const room = this.rooms.get(presentationId);
    if (room) room.fsmState = fsmState;
  }

  setPeerId(socketId: string, peerId: string): void {
    const presentationId = this.socketToRoom.get(socketId);
    if (!presentationId) return;
    const room = this.rooms.get(presentationId);
    if (!room) return;
    const member = room.members.get(socketId);
    if (member) member.peerId = peerId;
  }

  getPeerIds(presentationId: string): string[] {
    const room = this.rooms.get(presentationId);
    if (!room) return [];
    const ids: string[] = [];
    for (const member of room.members.values()) {
      if (member.peerId) ids.push(member.peerId);
    }
    return ids;
  }

  getRoom(presentationId: string): RoomState | undefined {
    return this.rooms.get(presentationId);
  }

  getRoomForSocket(socketId: string): string | undefined {
    return this.socketToRoom.get(socketId);
  }

  isHost(socketId: string): boolean {
    const presentationId = this.socketToRoom.get(socketId);
    if (!presentationId) return false;
    const room = this.rooms.get(presentationId);
    if (!room) return false;
    return room.members.get(socketId)?.role === "host";
  }

  getMemberCount(presentationId: string): number {
    return this.rooms.get(presentationId)?.members.size ?? 0;
  }
}
