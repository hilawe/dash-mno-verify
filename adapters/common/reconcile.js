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

// Call at startup. `ledgerSize` is how many grants the ledger already holds: a ledger with records is
// one this lifecycle has been running against, so it needs no gate. A fresh ledger on a platform that
// may already have members is the case that must stop.
export async function requireReconciled({ platform, markerPath, ledgerSize, instructions, target = null }) {
  if (ledgerSize > 0) return;
  if (await reconciliationDone(markerPath, target)) return;
  throw new Error(
    `refusing to start: ${platform} has no grant records yet, so this adapter cannot tell which ` +
      `current members it granted access to. Members admitted before the expiry lifecycle existed ` +
      `would keep access permanently and invisibly, because the sweep only looks at the ledger.\n\n` +
      `${instructions}\n\n` +
      `Then record that it is done:\n` +
      `  node -e "import('./adapters/common/reconcile.js').then(m => m.markReconciled('${markerPath}', { by: 'operator' }))"\n\n` +
      `A brand new group or room with no members yet is already in a closed state, so recording the ` +
      `marker straight away is the correct action there.`,
  );
}
