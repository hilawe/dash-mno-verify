// The member secret file, handled so that a re-run can never strand a member.
//
// The secret is the member's half of the two-tier registration: the gateway stores only its
// Poseidon commitment, so the secret exists in exactly one place, the member's disk. Losing it
// means losing the season, because the registration nullifier is already spent and the gateway
// cannot reissue what it never had.
//
// Two failure modes had to be closed at once, and they pull in opposite directions:
//
//   Overwrite. The old code wrote the file with a plain writeFile, which truncates. A member who
//   re-ran register (a stale root, an ambiguous response, a habit) generated a fresh secret, wrote
//   it over the accepted one, and got "already-registered" back. The accepted secret was gone.
//
//   Lost response. Writing the secret only after a successful response looks tidier, but if the
//   gateway commits the registration and the response is lost in transit, the member is left with
//   no secret at all, a spent seasonal nullifier, and no recovery. That trades a recoverable bug
//   for an unrecoverable one, so it is deliberately not what this does.
//
// The resolution: create the file exclusively (never truncate) BEFORE the network call, mark it
// pending, and promote it to accepted afterwards. A retry then finds the pending file and reuses
// that same secret rather than minting a new one, so the proof it rebuilds still matches the
// commitment the gateway may already hold.
import { open, readFile, chmod, rename, readdir } from "node:fs/promises";

const MODE = 0o600;

// One file per (platform, community, role, season), so registering for a second community or a new
// season cannot collide with a secret that is still in use. Anything outside a conservative
// character set is replaced, since these values come from a chat platform, not from us.
export function defaultSecretPath({ platform, community, role, season }) {
  const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, "_");
  return `member.${safe(platform)}.${safe(community)}.${safe(role)}.s${safe(season)}.secret.json`;
}

export async function readSecretFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

// Create the file exclusively and flush it to disk before returning. "wx" fails when the path
// exists, which is the whole point: an accepted secret is never silently replaced. fsync matters
// because the caller is about to spend up to an hour proving and then hand the commitment to the
// gateway; a secret still sitting in the page cache would not survive a crash in between.
export async function writePendingSecret(path, record) {
  const fh = await open(path, "wx", MODE);
  try {
    await fh.writeFile(JSON.stringify({ status: "pending", ...record }, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
}

// Promote a pending secret once the gateway has accepted the registration. The secret itself is
// unchanged, so this only records the outcome; a failure here is not fatal to the member, whose
// secret is already safe on disk.
export async function markSecretAccepted(path, extra = {}) {
  const current = await readSecretFile(path);
  if (current == null) return;
  // Write a sibling and rename over the original. A plain write truncates first, so a crash or power
  // loss during promotion could leave an empty or half-written file, destroying the only copy of the
  // secret and stranding the member for the season. That is the very failure this module exists to
  // prevent, so promotion has to be atomic too, not just creation.
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, "w", MODE);
  try {
    await fh.writeFile(JSON.stringify({ ...current, ...extra, status: "accepted" }, null, 2));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  await chmod(path, MODE);
}

// Find the secret that belongs to a challenge's context, so the per-epoch prove does not make the
// member remember which file goes with which community. Per-context filenames were introduced with
// the exclusive-create fix; the old single `member.secret.json` is still honoured as a fallback so
// a member who registered before the change is not stranded by it. Prefers an accepted record over
// a pending one, since a pending secret may never have been committed by the gateway.
export async function findSecretForContext(contextHashDec, season = null, dir = ".") {
  const candidates = [];
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (!name.endsWith(".secret.json")) continue;
    const path = dir === "." ? name : `${dir}/${name}`;
    const rec = await readSecretFile(path).catch(() => null);
    if (rec?.secret == null) continue;
    if (rec.contextHash != null && String(rec.contextHash) !== String(contextHashDec)) continue;
    // The context hash deliberately excludes the season, so after the first rollover the directory
    // holds an accepted secret for this context in EACH season. Without a season filter the choice
    // fell to readdir order, and picking last season's secret produces a commitment that is not in
    // the current members tree, so the proof simply fails to verify.
    if (season != null && rec.season != null && String(rec.season) !== String(season)) continue;
    candidates.push({ path, rec });
  }
  if (candidates.length === 0) return null;
  const exact = candidates.filter((c) => c.rec.season != null);
  const pool = exact.length ? exact : candidates; // legacy records carry no season; use them only alone
  const accepted = pool.filter((c) => c.rec.status === "accepted");
  if (accepted.length > 1) {
    throw new Error(
      `several accepted secrets match this context and season: ${accepted.map((c) => c.path).join(", ")}. ` +
        `Pass --secret to say which one to use.`,
    );
  }
  return (accepted[0] ?? pool[0]).path;
}

// Decide what to do about an existing secret file before registering.
//   fresh    no file, mint a new secret
//   retry    a pending file from an earlier attempt, reuse its secret
//   accepted already registered this season, refuse rather than overwrite
export async function resolveSecret(path, expected = {}) {
  const existing = await readSecretFile(path);
  if (existing == null) return { kind: "fresh" };
  // The filename replaces every unusual character with "_", so two different communities can map to
  // the same path (for example "a:b" and "a/b"). Reusing a pending secret across that collision would
  // publish the SAME commitment in two contexts and link the member across them, which is exactly the
  // unlinkability the design exists to provide. Compare the recorded context and season, not the name.
  const mismatched =
    (expected.contextHash != null &&
      existing.contextHash != null &&
      String(existing.contextHash) !== String(expected.contextHash)) ||
    (expected.season != null && existing.season != null && String(existing.season) !== String(expected.season));
  if (mismatched) return { kind: "mismatch", record: existing };
  if (existing.status === "accepted") return { kind: "accepted", record: existing };
  if (existing.secret) return { kind: "retry", record: existing };
  // A file with neither a status nor a secret is not something to guess about.
  return { kind: "unknown", record: existing };
}
