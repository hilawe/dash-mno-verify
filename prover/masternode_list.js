// Where a registration's masternode list comes from (found 2026-09-29), in its own module so it can be
// tested without proving.
//
// Taken from the gateway, the list is taken on trust. Anyone able to rewrite that response, the
// gateway's operator or a proxy that ends TLS in front of it, could serve a list holding only some
// masternodes and learn from whether the prover goes on to register whether the member's key is among
// them. Repeated, that narrows down which masternode is the member's, the one thing the proof exists to
// hide. Given a `masternodelist json` export of the member's OWN Dash node, the prover derives the list
// itself through the oracle's own derivation (oracle/snapshot.js) and never requests the gateway's
// copy. The gateway still decides whether that root is one it accepts, so a node a block or two apart
// from the oracle can be refused as stale-or-unknown-root, which costs a retry and reveals nothing.
import { readFile } from "node:fs/promises";
import { leavesFromMasternodeList } from "../oracle/snapshot.js";
import { makeDmlRootHasher } from "../common/dml_root.js";

export const UNCHECKED_LIST_WARNING =
  "[prover] using the gateway's masternode list without checking it. A gateway operator or a proxy in\n" +
  "front of it could use a doctored list to narrow down which masternode is yours. To avoid that, export\n" +
  "your own node's list (dash-cli masternodelist json > mnlist.json) and pass --node-list mnlist.json.";

// Returns { leaves, root, source }, leaves as decimal strings. `get(url)` fetches JSON from the gateway
// and is never called when nodeListPath is given.
export async function loadMasternodeList({ nodeListPath, gateway, get, depth, warn = console.warn }) {
  if (nodeListPath !== undefined) {
    let raw;
    try {
      raw = await readFile(nodeListPath, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      throw new Error(
        `${nodeListPath} was not found. Export your node's list with: dash-cli masternodelist json > ${nodeListPath} ` +
          "(add -testnet on testnet). With no node of your own, leave --node-list out to use the gateway's list unchecked.",
      );
    }
    const leaves = leavesFromMasternodeList(JSON.parse(raw)).map(String);
    return { leaves, root: (await makeDmlRootHasher(depth))(leaves), source: "node" };
  }
  warn(UNCHECKED_LIST_WARNING);
  const dml = await get(`${gateway}/v1/dml`);
  return { leaves: dml.leaves, root: dml.root, source: "gateway" };
}
