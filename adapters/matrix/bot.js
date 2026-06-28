// Matrix adapter for dash-mno-verify.
//
// Like the other adapters, this knows about Matrix and nothing about masternodes or
// zero-knowledge. It listens for "!verify", relays a challenge, takes the proof the member
// produced locally, verifies it through the gateway, and invites the member to the gated
// room. It uses the Matrix Client-Server API directly, so it needs no extra dependency.
import process from "node:process";
import { randomUUID } from "node:crypto";
import { proveInstructions } from "../../common/prover_instructions.js";
import { RoomStateTracker, isPrivateDirectRoomState } from "./room_privacy.js";

const HS = process.env.MATRIX_HOMESERVER; // e.g. https://matrix.org
const TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const USER_ID = process.env.MATRIX_USER_ID; // @yourbot:matrix.org
const GATED_ROOM = process.env.MATRIX_GATED_ROOM; // !roomid:matrix.org, bot must be able to invite
const GATEWAY = process.env.MNO_GATEWAY_URL ?? "http://127.0.0.1:8787";
// Adapter bearer token the gateway requires when MNO_ADAPTER_SECRET is set there (review B1/M5).
// This is the gateway token, distinct from the Matrix access token used by api() below.
const ADAPTER_SECRET = process.env.MNO_ADAPTER_SECRET;
const authHeaders = ADAPTER_SECRET ? { authorization: `Bearer ${ADAPTER_SECRET}` } : {};
const COMMUNITY = process.env.MATRIX_COMMUNITY ?? GATED_ROOM;
const ROLE = process.env.MATRIX_ROLE ?? "member";

const api = (path, opts = {}) =>
  fetch(`${HS}/_matrix/client/v3${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...opts.headers },
  });

async function sendText(roomId, text) {
  await api(`/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${randomUUID()}`, {
    method: "PUT",
    body: JSON.stringify({ msgtype: "m.text", body: text }),
  });
}

// Verification runs only in a private one-to-one room, so the challenge and the proof the member
// pastes back stay between the member and the bot, not in a shared room where others would see the
// proof and learn that this member controls a masternode. `state` is the room state as of this
// message (see room_privacy.js), so the decision reflects the room as it was when the message was
// sent, not a later read.
const DM_ONLY = "For your privacy, verify in a private direct message. Start a one-to-one chat with me and run !verify there. That keeps the challenge and your proof out of a shared room.";

async function handle(roomId, sender, body, state) {
  if (sender === USER_ID) return; // ignore our own messages
  const text = (body ?? "").trim();
  const isPrivate = () => isPrivateDirectRoomState({ state, botUserId: USER_ID, sender });

  if (text === "!verify") {
    if (!isPrivate()) return sendText(roomId, DM_ONLY);
    const res = await fetch(`${GATEWAY}/v1/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ platform: "matrix", communityId: COMMUNITY, roleId: ROLE, account: sender }),
    });
    if (!res.ok) return sendText(roomId, "Verification service is unavailable right now. Try again shortly.");
    const challenge = await res.json();
    return sendText(
      roomId,
      [
        "Anonymous masternode verification, step 1 of 2.",
        "On the machine holding your masternode voting key, save the challenge below as challenge.json and run:",
        ...proveInstructions(challenge.mode, { gateway: GATEWAY, platform: "matrix", community: COMMUNITY, role: ROLE }),
        "then paste the resulting proof.json back into this room.",
        "Your key, and which node you control, never leave your device.",
        "",
        "challenge:",
        JSON.stringify(challenge),
      ].join("\n")
    );
  }

  // a proof submission is a JSON message carrying nonce, proof, and publicSignals
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return;
  }
  if (!payload?.nonce || !payload?.proof || !payload?.publicSignals) return;

  // Only accept a proof in a private direct room, the same restriction as !verify. If a member pastes
  // a proof into a shared room, refuse it and point them to a direct message rather than grant on a
  // proof the whole room saw.
  if (!isPrivate()) return sendText(roomId, DM_ONLY);

  // Submit the account this sender is identified by. The gateway binds the verify to it (review B1).
  const res = await fetch(`${GATEWAY}/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders },
    body: JSON.stringify({ ...payload, account: sender }),
  });
  const out = await res.json();
  if (!out.ok) return sendText(roomId, `Verification failed (${out.reason ?? "unknown"}). Send !verify to start over.`);

  // access is membership in the gated room
  await api(`/rooms/${encodeURIComponent(GATED_ROOM)}/invite`, {
    method: "POST",
    body: JSON.stringify({ user_id: sender }),
  });
  return sendText(roomId, "Verified. You have been invited to the members room for this epoch.");
}

// The privacy check reads room state as of each message, so the bot keeps a room-state cache fed from
// every sync. The initial sync (no `since`) loads the current state of each joined room without
// replaying the message backlog, then the loop applies each batch's state and walks the timeline in
// order, updating state on state events and judging each message against the state at its position.
const rooms = new RoomStateTracker();
console.log(`[matrix] starting as ${USER_ID}`);

const init = await (await api("/sync?timeout=0")).json();
for (const [roomId, room] of Object.entries(init.rooms?.join ?? {})) {
  rooms.applyEvents(roomId, room.state?.events);
  rooms.applyEvents(roomId, room.timeline?.events); // applies state events only, the messages here are backlog
}
let since = init.next_batch;

for (;;) {
  const res = await api(`/sync?since=${since}&timeout=30000`);
  if (!res.ok) {
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  const data = await res.json();
  since = data.next_batch;
  for (const [roomId, room] of Object.entries(data.rooms?.join ?? {})) {
    rooms.applyEvents(roomId, room.state?.events); // catch-up state before the timeline window
    for (const ev of room.timeline?.events ?? []) {
      rooms.applyEvent(roomId, ev); // a no-op unless ev is a tracked state event
      if (ev.type === "m.room.message" && ev.content?.msgtype === "m.text") {
        // Snapshot now reflects every state event up to and including ones before this message.
        await handle(roomId, ev.sender, ev.content.body, rooms.snapshot(roomId)).catch((e) => console.error("[matrix]", e.message));
      }
    }
  }
  for (const roomId of Object.keys(data.rooms?.leave ?? {})) rooms.forget(roomId);
}
