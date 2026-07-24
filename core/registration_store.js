// Durable, season-scoped registration records for the two-tier flow.
//
// The atomic unit is one registration record:
//   { season, contextHash, regNullifier, commitment, index }
// deduped by a unique key on (season, contextHash, regNullifier). Appending a record is the
// single durable write that both spends the registration nullifier (one voting key registers
// once per season and context) and records the member commitment. The members tree is a cache
// rebuilt from these records, so a crash between the spend and the tree update cannot strand a
// member: on restart the record is present and the member is back in the tree.
//
// Two backends behind one interface:
//   FileBackend    append-only JSON lines, durable on a single gateway, needs no funded identity.
//   MemoryBackend  in-process, for tests and ephemeral single-gateway use.
// A Dash Platform backend that shares records across gateways follows the same interface and is
// wired in platform_store.js once the file path is proven; see docs/PLATFORM.md.
//
// Leaf order: forSeasonContext returns one (season, contextHash) bucket's records in insertion
// order, which is the order the members tree for that context is built over and the order
// /v1/members exposes, so a prover's leaf index (the position of its commitment in that list)
// matches the gateway's root. Records and their leaf index are scoped to (season, contextHash), so
// a registration for one community never appears in another community's tree (review finding B2).
// A FileBackend is a single writer, so insertion order is total and stable across restarts. A
// multi-gateway Platform backend must impose its own deterministic total order (for example sorted
// by regNullifier) so every gateway rebuilds the identical tree.
import { open, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// The statement a (season, contextHash) is registered under. The registration nullifier is derived
// differently per statement (docs/ZKVM_INTEGRATION.md, "Two statements"): the derive statement keys
// it on the private key, the custody statement cannot, so the two produce different nullifiers for
// the same node. Mixing them in one (season, contextHash) would let one node register twice, so a
// bucket is bound to a single statement, declared by its first registration and enforced on every
// later one. The engine (which proof system produced it) is recorded alongside for observability, and
// PLONK only supports derive.
export const ENGINE_STATEMENTS = Object.freeze({
  plonk: Object.freeze(["derive"]),
  zkvm: Object.freeze(["derive", "custody"]),
});
export function isValidEngineStatement(engine, statement) {
  // Object.hasOwn, not `ENGINE_STATEMENTS[engine]`, so an inherited property name like "constructor",
  // "toString", or "__proto__" returns false instead of reading a function and throwing on .includes.
  if (typeof engine !== "string" || typeof statement !== "string") return false;
  if (!Object.hasOwn(ENGINE_STATEMENTS, engine)) return false;
  return ENGINE_STATEMENTS[engine].includes(statement);
}
// Backward compatibility: a record written before this field existed is a PLONK derive registration,
// the only kind that existed then.
const DEFAULT_ENGINE = "plonk";
const DEFAULT_STATEMENT = "derive";

// The backend contract:
//   has({season, contextHash, regNullifier})    -> Promise<boolean>
//   append({season, contextHash, regNullifier, commitment})
//                                                -> Promise<{ duplicate, index }>
//   forSeasonContext(season, contextHash)        -> Promise<record[]>  (insertion order)
// where `duplicate` is true when the unique key rejected the insert, and `index` is the leaf
// position assigned within the (season, contextHash) bucket.
export class RegistrationStore {
  constructor(backend) {
    this.backend = backend;
  }
  async ready() {
    if (this.backend.ready) await this.backend.ready();
  }
  has(season, contextHash, regNullifier) {
    return this.backend.has({
      season: Number(season),
      contextHash: String(contextHash),
      regNullifier: String(regNullifier),
    });
  }
  append({ season, contextHash, regNullifier, commitment, engine = DEFAULT_ENGINE, statement = DEFAULT_STATEMENT }) {
    // Reject an impossible engine/statement pair up front (for example PLONK custody), so a bucket
    // can never be declared under one. The per-bucket consistency check is the backend's, inside the
    // serialized append.
    if (!isValidEngineStatement(engine, statement)) {
      return Promise.resolve({ invalid: true, engine: String(engine), statement: String(statement) });
    }
    return this.backend.append({
      season: Number(season),
      contextHash: String(contextHash),
      regNullifier: String(regNullifier),
      commitment: String(commitment),
      engine: String(engine),
      statement: String(statement),
    });
  }
  forSeasonContext(season, contextHash) {
    return this.backend.forSeasonContext(Number(season), String(contextHash));
  }
  // The (engine, statement) a (season, contextHash) is declared under, or null if it has no
  // registration yet. The first record's declaration, so it is stable for the bucket's life.
  declarationFor(season, contextHash) {
    return this.backend.declarationFor(Number(season), String(contextHash));
  }
  // Whether any context in this season is declared under `engine`. The gateway uses this to make the
  // dual-root downgrade rule consider durable declarations, not just configured intent: a deployment
  // with a current-season zkVM registration must keep requiring v2 snapshots even if the config flag
  // is later unset (docs/ZKVM_INTEGRATION.md, the downgrade rule).
  seasonHasEngine(season, engine) {
    return this.backend.seasonHasEngine(Number(season), String(engine));
  }
}

// The declaration a bucket is bound to: the first record's (engine, statement), defaulting a legacy
// record with neither field to PLONK derive.
function declarationOfRecord(record) {
  return { engine: record.engine ?? DEFAULT_ENGINE, statement: record.statement ?? DEFAULT_STATEMENT };
}
function sameDeclaration(a, b) {
  return a.engine === b.engine && a.statement === b.statement;
}

// The unique key spends one registration nullifier per (season, contextHash). The bucket key is
// that same scope minus the nullifier, and groups the records whose commitments form one context's
// members tree.
function keyOf(d) {
  return `${d.season}:${d.contextHash}:${d.regNullifier}`;
}
function bucketOf(d) {
  return `${d.season}:${d.contextHash}`;
}

// In-memory backend that enforces the same unique key and per-(season, context) indexing, for tests
// and ephemeral single-gateway use. Not durable: a restart loses every record.
export class MemoryRegistrationBackend {
  constructor() {
    this.seen = new Set();
    this.byBucket = new Map(); // "season:contextHash" -> records[] in insertion order
  }
  async has(d) {
    return this.seen.has(keyOf(d));
  }
  async append(d) {
    const k = keyOf(d);
    if (this.seen.has(k)) return { duplicate: true };
    const b = bucketOf(d);
    const recs = this.byBucket.get(b) ?? [];
    // A bucket is bound to one (engine, statement): the first record declares it, a later record
    // with a different declaration is a conflict and is rejected without being written.
    const want = declarationOfRecord(d);
    if (recs.length > 0) {
      const declared = declarationOfRecord(recs[0]);
      if (!sameDeclaration(declared, want)) return { conflict: true, declared };
    }
    const index = recs.length;
    const record = {
      season: d.season,
      contextHash: d.contextHash,
      regNullifier: d.regNullifier,
      commitment: d.commitment,
      engine: d.engine,
      statement: d.statement,
      index,
    };
    this.seen.add(k);
    recs.push(record);
    this.byBucket.set(b, recs);
    return { duplicate: false, index };
  }
  async forSeasonContext(season, contextHash) {
    return [...(this.byBucket.get(`${season}:${contextHash}`) ?? [])];
  }
  async declarationFor(season, contextHash) {
    const recs = this.byBucket.get(`${season}:${contextHash}`);
    return recs && recs.length > 0 ? declarationOfRecord(recs[0]) : null;
  }
  async seasonHasEngine(season, engine) {
    return bucketsHaveEngine(this.byBucket, season, engine);
  }
}

// True if any (season, *) bucket's declaration uses `engine`. Scans the season's buckets, reading
// each bucket's declaration from its first record.
function bucketsHaveEngine(byBucket, season, engine) {
  const prefix = `${season}:`;
  for (const [bucket, recs] of byBucket) {
    if (!bucket.startsWith(prefix)) continue;
    if (recs.length > 0 && declarationOfRecord(recs[0]).engine === engine) return true;
  }
  return false;
}

// Durable append-only backend. One JSON record per line. The in-memory index is rebuilt from
// the file on load, so the tree survives a restart and every member keeps their leaf position.
export class FileBackend {
  constructor(path) {
    this.path = path;
    this.seen = new Set();
    this.byBucket = new Map(); // "season:contextHash" -> records[] in insertion order
    this._loading = null; // memoized load, so concurrent first-callers share one read
    this._tail = Promise.resolve(); // append mutex, see append()
  }

  // Load the file once. Memoizing the in-flight promise keeps two concurrent first-callers from
  // both reading the file and double-populating the in-memory index.
  ready() {
    if (!this._loading) this._loading = this.#load();
    return this._loading;
  }

  async #load() {
    await mkdir(dirname(this.path), { recursive: true });
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      this.#remember(JSON.parse(t));
    }
  }

  #remember(record) {
    this.seen.add(keyOf(record));
    const b = bucketOf(record);
    const recs = this.byBucket.get(b) ?? [];
    recs.push(record);
    this.byBucket.set(b, recs);
  }

  async has(d) {
    await this.ready();
    return this.seen.has(keyOf(d));
  }

  // Appends are serialized through a promise chain so the unique-key check, the index
  // assignment, and the durable write form one critical section. Node runs one task at a time,
  // so chaining on _tail is enough; the swallow keeps a failed append from wedging later ones.
  append(d) {
    const result = this._tail.then(() => this.#appendOne(d));
    this._tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #appendOne(d) {
    await this.ready();
    const k = keyOf(d);
    if (this.seen.has(k)) return { duplicate: true };
    const recs = this.byBucket.get(bucketOf(d)) ?? [];
    // The bucket's declaration is enforced inside this serialized section, so two concurrent first
    // registrations cannot set conflicting declarations: the second sees the first's record.
    const want = declarationOfRecord(d);
    if (recs.length > 0) {
      const declared = declarationOfRecord(recs[0]);
      if (!sameDeclaration(declared, want)) return { conflict: true, declared };
    }
    const index = recs.length;
    const record = {
      season: d.season,
      contextHash: d.contextHash,
      regNullifier: d.regNullifier,
      commitment: d.commitment,
      engine: d.engine,
      statement: d.statement,
      index,
    };
    const fh = await open(this.path, "a");
    try {
      await fh.appendFile(JSON.stringify(record) + "\n");
      await fh.sync(); // the record is on disk before we report success
    } finally {
      await fh.close();
    }
    this.#remember(record);
    return { duplicate: false, index };
  }

  async forSeasonContext(season, contextHash) {
    await this.ready();
    return [...(this.byBucket.get(`${season}:${contextHash}`) ?? [])];
  }

  async declarationFor(season, contextHash) {
    await this.ready();
    const recs = this.byBucket.get(`${season}:${contextHash}`);
    return recs && recs.length > 0 ? declarationOfRecord(recs[0]) : null;
  }

  async seasonHasEngine(season, engine) {
    await this.ready();
    return bucketsHaveEngine(this.byBucket, season, engine);
  }
}
