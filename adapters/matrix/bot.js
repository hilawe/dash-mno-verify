// Matrix adapter for dash-mno-verify.
//
// Like the other adapters, this knows about Matrix and nothing about masternodes or
// zero-knowledge. It listens for "!verify", relays a challenge, takes the proof the member
// produced locally, verifies it through the gateway, and invites the member to the gated
// room. It uses the Matrix Client-Server API directly, so it needs no extra dependency.
import process from "node:process";
import { randomUUID } from "node:crypto";

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

async function handle(roomId, sender, body) {
  if (sender === USER_ID) return; // ignore our own messages
  const text = (body ?? "").trim();

  if (text === "!verify") {
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
        "On the machine holding your masternode voting key, run the prover with the challenge below,",
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

// Skip the backlog by taking a fresh sync token, then long-poll for new messages.
console.log(`[matrix] starting as ${USER_ID}`);
let since = (await (await api("/sync?timeout=0")).json()).next_batch;
for (;;) {
  const res = await api(`/sync?since=${since}&timeout=30000`);
  if (!res.ok) {
    await new Promise((r) => setTimeout(r, 3000));
    continue;
  }
  const data = await res.json();
  since = data.next_batch;
  for (const [roomId, room] of Object.entries(data.rooms?.join ?? {})) {
    for (const ev of room.timeline?.events ?? []) {
      if (ev.type === "m.room.message" && ev.content?.msgtype === "m.text") {
        await handle(roomId, ev.sender, ev.content.body).catch((e) => console.error("[matrix]", e.message));
      }
    }
  }
}
