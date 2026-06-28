import { test } from "node:test";
import assert from "node:assert/strict";
import { RoomStateTracker, isPrivateDirectRoomState } from "../adapters/matrix/room_privacy.js";

// The Matrix verification gate is a privacy policy, not cryptography, so test it directly. A room
// qualifies only when, as of the message, it is a one-to-one chat with the bot and the sender,
// invite-only, and joined-only history. Everything else must be rejected.

const BOT = "@bot:hs";
const member = (uid, membership) => ({ type: "m.room.member", state_key: uid, content: { membership } });
const joinRule = (rule) => ({ type: "m.room.join_rules", content: { join_rule: rule } });
const history = (vis) => ({ type: "m.room.history_visibility", content: { history_visibility: vis } });
const msg = (sender) => ({ type: "m.room.message", sender, content: { msgtype: "m.text", body: "proof" } });

const state = (members, jr, hv) => ({ members, joinRule: jr, historyVisibility: hv });
const isPriv = (s, sender = "@m:hs") => isPrivateDirectRoomState({ state: s, botUserId: BOT, sender });

test("a 1:1 invite-only joined-history room is private", () => {
  assert.equal(isPriv(state([BOT, "@m:hs"], "invite", "joined")), true);
});

test("a public-join room is rejected even with two members", () => {
  assert.equal(isPriv(state([BOT, "@m:hs"], "public", "joined")), false);
});

test("any history visibility other than joined is rejected", () => {
  for (const v of ["invited", "shared", "world_readable"]) {
    assert.equal(isPriv(state([BOT, "@m:hs"], "invite", v)), false, v);
  }
});

test("a room with more than two members is rejected", () => {
  assert.equal(isPriv(state([BOT, "@m:hs", "@x:hs"], "invite", "joined")), false);
});

test("a room the bot is not in is rejected", () => {
  assert.equal(isPriv(state(["@a:hs", "@m:hs"], "invite", "joined")), false);
});

test("a message whose sender is not the other member is rejected", () => {
  assert.equal(isPriv(state([BOT, "@alice:hs"], "invite", "joined"), "@bob:hs"), false);
});

test("an unknown room (no tracked state) is rejected", () => {
  assert.equal(isPrivateDirectRoomState({ state: null, botUserId: BOT, sender: "@m:hs" }), false);
});

test("the tracker accumulates membership, join rule, and history, and forgets on demand", () => {
  const t = new RoomStateTracker();
  assert.equal(t.snapshot("!r"), null);
  t.applyEvents("!r", [member(BOT, "join"), member("@m:hs", "join"), joinRule("invite"), history("joined")]);
  assert.deepEqual(t.snapshot("!r"), { members: [BOT, "@m:hs"], joinRule: "invite", historyVisibility: "joined" });
  t.applyEvent("!r", member("@m:hs", "leave"));
  assert.deepEqual(t.snapshot("!r").members, [BOT]);
  t.forget("!r");
  assert.equal(t.snapshot("!r"), null);
});

// The event-time fix: a proof posted while a third member is present is judged shared, even though
// that member leaves before the next message. A live read after the leave would wrongly accept it.
test("a message is judged against room state as of the event, not later", () => {
  const t = new RoomStateTracker();
  const R = "!r";
  t.applyEvents(R, [member(BOT, "join"), member("@alice:hs", "join"), member("@bob:hs", "join"), joinRule("invite"), history("joined")]);
  const timeline = [msg("@alice:hs"), member("@bob:hs", "leave"), msg("@alice:hs")];
  const decisions = [];
  for (const ev of timeline) {
    t.applyEvent(R, ev);
    if (ev.type === "m.room.message") {
      decisions.push(isPrivateDirectRoomState({ state: t.snapshot(R), botUserId: BOT, sender: ev.sender }));
    }
  }
  assert.deepEqual(decisions, [false, true]); // first proof saw three members, second saw two
});
