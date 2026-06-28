// Decide whether a Matrix room is a private one-to-one chat fit to run verification in, so the
// challenge and the proof the member pastes back are kept out of a shared room.
//
// The decision is made from the room state as of the event being handled, not from a live read after
// the fact. RoomStateTracker accumulates membership, join rule, and history visibility from each
// /sync batch (the per-room `state` section, then state events interleaved in the timeline), so when
// the bot reaches a message in the timeline it can evaluate the room exactly as it stood when that
// message was sent. That closes a time-of-check gap a live read would leave open: a room that was
// shared when the proof was posted, then trimmed to two members before the bot handled it, is judged
// on how it was at posting time, not after.
//
// A room qualifies only when all three hold at that point:
//   - exactly two joined members, the bot and the sender of this message (a one-to-one chat)
//   - join rule "invite", so no one else can wander in
//   - history visibility exactly "joined", so a member sees only messages sent after they join. A
//     room can have only the bot and member joined yet a third user already invited, and "invited",
//     the Matrix default "shared", and "world_readable" would each let that pending invitee or an
//     outsider read the proof, so only "joined" qualifies.
//
// Anything else, or a room the tracker has never seen state for, is treated as not private, so the
// bot fails closed and declines rather than risk posting where others could see it.

// The state we track per room, the minimum the privacy predicate needs.
export class RoomStateTracker {
  constructor() {
    this.rooms = new Map(); // roomId -> { members: Set<string>, joinRule, historyVisibility }
  }
  #room(roomId) {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = { members: new Set(), joinRule: null, historyVisibility: null };
      this.rooms.set(roomId, r);
    }
    return r;
  }
  // Apply one event. A no-op for anything that is not one of the three state events we track, so it
  // is safe to call on every timeline event in order.
  applyEvent(roomId, ev) {
    if (!ev || typeof ev.type !== "string") return;
    const r = this.#room(roomId);
    if (ev.type === "m.room.member") {
      if (ev.content?.membership === "join") r.members.add(ev.state_key);
      else r.members.delete(ev.state_key); // leave, ban, invite, knock are all "not joined"
    } else if (ev.type === "m.room.join_rules") {
      if (ev.content?.join_rule != null) r.joinRule = ev.content.join_rule;
    } else if (ev.type === "m.room.history_visibility") {
      if (ev.content?.history_visibility != null) r.historyVisibility = ev.content.history_visibility;
    }
  }
  applyEvents(roomId, events) {
    for (const ev of events ?? []) this.applyEvent(roomId, ev);
  }
  // The room state as it stands now, for the privacy predicate. null if the room is unknown.
  snapshot(roomId) {
    const r = this.rooms.get(roomId);
    if (!r) return null;
    return { members: [...r.members], joinRule: r.joinRule, historyVisibility: r.historyVisibility };
  }
  forget(roomId) {
    this.rooms.delete(roomId);
  }
}

// Pure privacy predicate over a room-state snapshot, so it is trivially testable and makes no network
// call. See the three conditions documented above.
export function isPrivateDirectRoomState({ state, botUserId, sender }) {
  if (!state) return false;
  const ids = state.members;
  if (ids.length !== 2 || !ids.includes(botUserId) || !ids.includes(sender)) return false;
  if (state.joinRule !== "invite") return false;
  if (state.historyVisibility !== "joined") return false;
  return true;
}
