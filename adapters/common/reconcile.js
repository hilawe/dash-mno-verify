// The upgrade gate for adapters that previously admitted members and never removed them.
//
// The grant ledger only knows about access IT issued. Before this lifecycle existed, the Telegram and
// Matrix adapters invited members and never looked again, so on upgrade those members are already in
// the group or room with no record behind them. The sweeps iterate the ledger, not platform
// membership, so every one of them would keep access permanently and invisibly. Fixing admissions
// going forward does not fix the ones already granted.
//
// So an adapter with a fresh ledger refuses to start until the operator has established a closed
// starting state and recorded that they did. The marker is deliberately a separate file rather than
// an environment variable: it should survive a restart and be an explicit, auditable act, not a flag
// someone copies into a service definition and forgets.
//
// Matrix can reconcile itself (the room membership is readable, so the bot can remove members it
// has no live grant for). Telegram cannot: the Bot API exposes no general member roster, so that
// side needs a new gated group, an externally sourced list, or a manual pass by an admin.
import { readFile, writeFile, mkdir, rename, open } from "node:fs/promises";
import { dirname } from "node:path";

// The raw marker, or null when there is none. Callers that need more than "is it done" read this:
// the Discord pass uses the recorded target history to find access left behind by a PREVIOUS role or
// channel set, which is invisible to a pass that only enumerates the current one.
export async function readMarker(markerPath) {
  try {
    const raw = JSON.parse(await readFile(markerPath, "utf8"));
    return raw?.reconciled === true ? raw : null;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw new Error(`cannot read the reconciliation marker at ${markerPath} (${e.message}). Fix or remove it.`);
  }
}

export async function reconciliationDone(markerPath, target = null) {
  try {
    const raw = JSON.parse(await readFile(markerPath, "utf8"));
    if (raw?.reconciled !== true) return false;
    // A marker says "this target was reconciled", not "reconciliation happened once". Without the
    // binding, a marker earned for one room or group would satisfy the gate after the operator
    // pointed the bot at a different one, which is the case with unknown pre-existing members.
    if (target != null && String(raw.target ?? "") !== String(target)) return false;
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw new Error(`cannot read the reconciliation marker at ${markerPath} (${e.message}). Fix or remove it.`);
  }
}

export async function markReconciled(markerPath, detail = {}) {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  // Write, flush, rename: a marker lost to a power loss would simply re-run reconciliation, which is
  // safe, but a HALF-WRITTEN one would fail the JSON parse and refuse startup, so make it atomic.
  const tmp = `${markerPath}.tmp`;
  const fh = await open(tmp, "w", 0o600);
  try {
    await fh.writeFile(JSON.stringify({ reconciled: true, ...detail }, null, 2));
    await fh.sync();
  } finally {
    await fh.close().catch(() => {});
  }
  await rename(tmp, markerPath);
}

// A single-quoted JavaScript string literal, for building the recovery command below. The command is
// printed inside a double-quoted shell argument, so it must introduce no double quotes of its own,
// which rules out JSON.stringify. Values here come from the operator's own configuration, but a
// group id carrying a quote would otherwise produce a command that silently will not parse.
const jsLiteral = (v) => `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

// Call at startup. `ledgerCovers` says whether the ledger already holds a grant FOR THIS TARGET: such
// a ledger belongs to a lifecycle that has been running against this room or group, so it needs no
// gate. It deliberately is not a plain record count. A ledger full of records for a previous target
// says nothing about the members of the one now configured, and letting a non-empty ledger satisfy
// the gate meant pointing the bot at an existing second group skipped reconciliation entirely, so
// that group's current members kept access permanently and invisibly.
export async function requireReconciled({ platform, markerPath, ledgerCovers, instructions, target = null }) {
  // The marker is checked FIRST and is target-scoped, so a correctly recorded reconciliation always
  // passes regardless of what the ledger holds.
  if (await reconciliationDone(markerPath, target)) return;
  if (ledgerCovers) return;
  // The printed command has to record the target, because reconciliationDone compares it. Without it
  // the operator ran exactly what this error told them to run, wrote a marker with no target, and hit
  // the same refusal on the next start with no way through. Telegram cannot self-reconcile, so this
  // command is its only path.
  const detail = `{ by: 'operator'${target == null ? "" : `, target: ${jsLiteral(target)}`} }`;
  throw new Error(
    `refusing to start: ${platform} has no grant records for ${target ?? "this target"} yet, so this ` +
      `adapter cannot tell which current members it granted access to. Members admitted before the ` +
      `expiry lifecycle existed would keep access permanently and invisibly, because the sweep only ` +
      `looks at the ledger.\n\n` +
      `${instructions}\n\n` +
      `Then record that it is done:\n` +
      `  node -e "import('./adapters/common/reconcile.js').then(m => m.markReconciled(${jsLiteral(markerPath)}, ${detail}))"\n\n` +
      `A brand new group or room with no members yet is already in a closed state, so recording the ` +
      `marker straight away is the correct action there.`,
  );
}
