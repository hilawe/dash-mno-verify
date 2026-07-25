// Durable nullifier (claim) store, backed by SQLite through the Node standard library.
//
// Why this exists. The in-memory NullifierStore (core/stores.js) holds the spent set in a Map, so a
// gateway restart mid-epoch forgets every spend. Registrations are durable, but the per-epoch claim
// was not, and the same member secret could then claim a second account inside one epoch. That
// breaks the standing "one voting key, one membership per epoch and context" invariant, which is the
// property the whole system exists to provide. A restart is an ordinary operational event, not an
// attack, so the guarantee has to survive one.
//
// Why SQLite rather than another file format. The store needs exactly three things that a
// hand-rolled file makes hard and a database gives directly: an atomic unique insert (so a race
// between two requests for the same tag has one winner without an application-level lock), a durable
// commit before the caller is told the spend succeeded, and cheap deletion of epochs that have aged
// out. node:sqlite is part of Node, so this adds no npm dependency and no native build step, which
// keeps the oracle-only and gateway-only installs unchanged.
//
// It satisfies the same contract as every other nullifier store (test/nullifier_store_contract.test.js):
//   has(epoch, contextHash, nf)              -> boolean
//   get(epoch, contextHash, nf)              -> { account } | null
//   add(epoch, contextHash, nf, { account }) -> { duplicate }
// add() is the authority. The verifier's has() call ahead of it is only an early reject that avoids
// an expensive proof verify on an ordinary replay; the insert is what actually decides a race.
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";

// The claim key is (epoch, contextHash, nullifier), stored as TEXT because the verifier carries these
// as decimal strings taken from the proof's public signals, and a string key keeps the comparison
// exact. epoch_n is the same epoch as an integer, kept only so pruning can compare numerically
// without casting every row.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS claims (
    epoch      TEXT    NOT NULL,
    context    TEXT    NOT NULL,
    nf         TEXT    NOT NULL,
    account    TEXT,
    epoch_n    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (epoch, context, nf)
  );
  CREATE INDEX IF NOT EXISTS claims_epoch_n ON claims (epoch_n);
`;

export class SqliteNullifierStore {
  // `path` is a file path, or ":memory:" for tests. Opening is synchronous and cheap.
  constructor(path) {
    this.path = path;
    this.db = new DatabaseSync(path);
    // WAL keeps readers off the writer's back. synchronous=FULL is the deliberate choice here: the
    // caller is told a spend succeeded only after the write reached disk, so a power loss cannot
    // resurrect a spent tag. The cost is one fsync per claim, which is a rounding error next to the
    // proof verify that precedes it.
    // Narrow the file BEFORE enabling write-ahead logging. This database pairs platform accounts with
    // the nullifiers they claimed, so it says which accounts hold a masternode (never which node, and
    // never an address). SQLite creates the sibling -wal and -shm files from the database file's own
    // mode, so doing this after the WAL pragma left those two world readable while holding the same
    // rows. Refuse to start if the mode cannot be set, rather than run with the claims exposed.
    if (path !== ":memory:") {
      try {
        chmodSync(path, 0o600);
      } catch (e) {
        throw new Error(`refusing to start: cannot restrict ${path} to mode 0600 (${e.message})`);
      }
    }
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec(SCHEMA);
    this._has = this.db.prepare("SELECT 1 FROM claims WHERE epoch=? AND context=? AND nf=?");
    this._get = this.db.prepare("SELECT account FROM claims WHERE epoch=? AND context=? AND nf=?");
    this._add = this.db.prepare(
      "INSERT INTO claims (epoch, context, nf, account, epoch_n, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING"
    );
    this._prune = this.db.prepare("DELETE FROM claims WHERE epoch_n < ?");
    this._count = this.db.prepare("SELECT COUNT(*) AS n FROM claims");
  }

  #keys(epoch, contextHash, nf) {
    return [String(epoch), String(contextHash), String(nf)];
  }

  has(epoch, contextHash, nf) {
    return this._has.get(...this.#keys(epoch, contextHash, nf)) !== undefined;
  }

  // The claim record for a spent tag, or null. Carries the account that first claimed it, which is
  // what lets that same account re-verify and re-grant within the epoch after an adapter failure.
  get(epoch, contextHash, nf) {
    const row = this._get.get(...this.#keys(epoch, contextHash, nf));
    if (row === undefined) return null;
    // A null account column reads back as null, matching a store that does not persist the account.
    return { account: row.account ?? null };
  }

  // Record the spend. `changes === 0` means the unique key was already present, so another request
  // won the race; the caller decides whether that prior claim belongs to the same account.
  add(epoch, contextHash, nf, record = {}) {
    const [e, c, n] = this.#keys(epoch, contextHash, nf);
    const epochN = Number.parseInt(e, 10);
    const res = this._add.run(
      e,
      c,
      n,
      record.account == null ? null : String(record.account),
      Number.isFinite(epochN) ? epochN : 0,
      Date.now()
    );
    return { duplicate: res.changes === 0 };
  }

  // Drop claims from epochs strictly older than `minEpoch`.
  //
  // The window is a correctness boundary, not housekeeping. Deleting the current epoch would forget
  // live spends and reopen exactly the double-claim hole this store closes, so the caller must pass
  // an epoch that is already past the accepted-root window and the re-grant window. Erring toward
  // keeping too much is safe; erring toward deleting too much is not.
  prune(minEpoch) {
    const n = Number.parseInt(String(minEpoch), 10);
    if (!Number.isFinite(n)) return { removed: 0 };
    return { removed: this._prune.run(n).changes };
  }

  size() {
    return this._count.get().n;
  }

  close() {
    this.db.close();
  }
}
