// Shared nullifier state on Dash Platform, so several gateways enforce one spent set.
//
// The contract's `nullifier` document type has a unique index on (epoch, contextHash, nf),
// so Platform consensus itself rejects a second gateway that tries to record the same tag.
// That is the point: independent gateways cannot double-grant, because the second insert of
// a tag loses at the contract level.
//
// The store logic here is backend-agnostic and is unit-tested against an in-memory backend
// that mimics the unique index (see test/platform_store.test.js). The live Dash Platform
// backend is isolated in platformBackend() and needs a funded identity plus DAPI access, so
// it is documented in docs/PLATFORM.md rather than run in CI.

// A nullifier store over a document backend. The backend provides:
//   exists({epoch, contextHash, nf}) -> Promise<boolean>
//   insert({epoch, contextHash, nf}) -> Promise<{ duplicate: boolean }>
// where `duplicate` is true when the unique index rejected the insert (another gateway got
// there first). The gateway awaits has(), get(), and add(), so this drops in for the
// in-memory store.
export class DocumentNullifierStore {
  constructor(backend) {
    this.backend = backend;
  }
  async has(epoch, contextHash, nf) {
    return this.backend.exists({ epoch: Number(epoch), contextHash: String(contextHash), nf: String(nf) });
  }
  // The granting account is deliberately not persisted on Platform: writing a platform user id, or
  // anything derived from it, into a public document would link that user to "controls a masternode"
  // for anyone reading the chain, the privacy regression the whole design avoids. So get() returns
  // null and re-grant (idempotent grants) is a memory-mode property. A durable, privacy-preserving
  // claim on Platform needs an account commitment under a shared cluster secret plus a contract
  // field, a deliberate design step tracked in TODO.md, not a silent default.
  async get() {
    return null;
  }
  // The claim record's account is accepted for interface parity with the in-memory store but not
  // written to Platform yet (see get()). The unique index on (epoch, contextHash, nf) still gives
  // one spend per tag across gateways.
  async add(epoch, contextHash, nf, _record = {}) {
    return this.backend.insert({ epoch: Number(epoch), contextHash: String(contextHash), nf: String(nf) });
  }
}

// In-memory backend that enforces the same unique index, for tests and single-gateway use.
export class MemoryBackend {
  constructor() {
    this.seen = new Set();
  }
  key(d) {
    return `${d.epoch}:${d.contextHash}:${d.nf}`;
  }
  async exists(d) {
    return this.seen.has(this.key(d));
  }
  async insert(d) {
    const k = this.key(d);
    if (this.seen.has(k)) return { duplicate: true };
    this.seen.add(k);
    return { duplicate: false };
  }
}

// Decimal field element to a 32-byte big-endian buffer, for the contract's byteArray fields.
function toBytes32(decimal) {
  return Buffer.from(BigInt(decimal).toString(16).padStart(64, "0"), "hex");
}

// Live Dash Platform backend. `client` is a Dash SDK Client, `identity` the gateway's
// Platform identity, `appName` the name the contract is registered under on the client, and
// `typeName` the nullifier document type. Kept thin and tied to the contract so the part
// that depends on SDK bootstrap (client and identity) is configured by the caller. See
// docs/PLATFORM.md. Not exercised in CI.
export function platformBackend({ client, identity, appName = "mnoVerify", typeName = "nullifier" }) {
  const locator = `${appName}.${typeName}`;
  return {
    async exists({ epoch, contextHash, nf }) {
      const docs = await client.platform.documents.get(locator, {
        where: [
          ["epoch", "==", epoch],
          ["contextHash", "==", toBytes32(contextHash)],
          ["nf", "==", toBytes32(nf)],
        ],
        limit: 1,
      });
      return docs.length > 0;
    },
    async insert({ epoch, contextHash, nf }) {
      try {
        const doc = await client.platform.documents.create(locator, identity, {
          epoch,
          contextHash: toBytes32(contextHash),
          nf: toBytes32(nf),
        });
        await client.platform.documents.broadcast({ create: [doc] }, identity);
        return { duplicate: false };
      } catch (err) {
        // a unique-index violation means another gateway already recorded this tag
        if (/unique|duplicate|already exists/i.test(String(err?.message))) return { duplicate: true };
        throw err;
      }
    },
  };
}

// Build a live backend from config, lazy-importing the optional `dash` SDK so the core does
// not depend on it. Throws a clear message if dash is not installed. The exact wallet and
// identity wiring is deployment-specific; see docs/PLATFORM.md.
export async function connectPlatform({ network, mnemonic, contractId, appName = "mnoVerify", typeName = "nullifier" }) {
  let Dash;
  try {
    Dash = (await import("dash")).default;
  } catch {
    throw new Error("MNO_STORE=platform needs the optional 'dash' dependency: npm install dash");
  }
  const client = new Dash.Client({
    network,
    wallet: { mnemonic },
    apps: { [appName]: { contractId } },
  });
  const account = await client.getWalletAccount();
  const identityId = account.identities.getIdentityIds()[0];
  const identity = await client.platform.identities.get(identityId);
  return platformBackend({ client, identity, appName, typeName });
}
