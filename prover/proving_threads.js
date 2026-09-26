// Release snarkjs's proving threads so a command-line prover can exit.
//
// snarkjs builds the BN128 curve with a pool of worker threads, and ffjavascript caches that curve on
// globalThis.curve_bn128 for reuse. The idle workers keep Node's event loop alive, so a CLI that proves
// and then simply returns never exits. The snarkjs command-line tool sidesteps this with process.exit,
// and the library leaves it to the caller. This was found on 2026-09-26 when the single-tier prover
// wrote proof.json on a masternode and then sat idle holding 5.8 GiB until it was stopped by hand.
//
// Every CLI here that proves calls this after proving, in a finally, so a failed proof releases the
// threads too. A long-running process such as the gateway does not call it, since it reuses the curve.
import * as snarkjs from "snarkjs";

export async function releaseProvingThreads() {
  // Only a curve that already exists is released. getCurveFromName returns the cached one, so this ends
  // the pool the proof used. Calling it with no cached curve would BUILD a new pool just to end it.
  if (!globalThis.curve_bn128) return;
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  await curve.terminate();
}
