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
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export async function reconciliationDone(markerPath) {
  try {
    const raw = JSON.parse(await readFile(markerPath, "utf8"));
    return raw?.reconciled === true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw new Error(`cannot read the reconciliation marker at ${markerPath} (${e.message}). Fix or remove it.`);
  }
}

export async function markReconciled(markerPath, detail = {}) {
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 });
  await writeFile(markerPath, JSON.stringify({ reconciled: true, ...detail }, null, 2), { mode: 0o600 });
}

// Call at startup. `ledgerSize` is how many grants the ledger already holds: a ledger with records is
// one this lifecycle has been running against, so it needs no gate. A fresh ledger on a platform that
// may already have members is the case that must stop.
export async function requireReconciled({ platform, markerPath, ledgerSize, instructions }) {
  if (ledgerSize > 0) return;
  if (await reconciliationDone(markerPath)) return;
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
