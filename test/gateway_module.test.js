import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "../core/config.js";
import { createGateway } from "../core/gateway.js";
import { makeDmlRootHasher } from "../core/dml_root.js";
import { signalHash } from "../common/index.js";

// The gateway as a MODULE rather than as a process. Everything here was unreachable while
// core/gateway.js opened its stores and bound a socket at import time: a boot refusal could only be
// observed as a subprocess exit code, a limiter could only be reasoned about, and one test resorted
// to grepping this file's sibling source text for a call it had no other way to see.
//
// These run in the test process, so each one must give back what it took. Every gateway is closed in
// a finally block, and the first test below is the one that checks close() actually does that.

const REPO = fileURLToPath(new URL("../", import.meta.url));
const rootHasher = await makeDmlRootHasher();
const LEAVES = ["111", "222", "333"];
const ROOT = rootHasher(LEAVES);

// A base environment that boots: unauthenticated and unsigned on purpose (the two fail-closed
// refusals are exercised as their own cases below), ephemeral spent set, and a real self-consistent
// snapshot on disk so the challenge path has a root to serve rather than answering 503.
async function envWithSnapshot(over = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mno-gw-mod-"));
  const source = join(dir, "root.json");
  await writeFile(
    source,
    JSON.stringify({ height: 1, blockHash: "ab".repeat(32), depth: 16, root: ROOT, leaves: LEAVES, ts: Math.floor(Date.now() / 1000) }),
  );
  return {
    dir,
    env: {
      MNO_MODE: "single",
      MNO_STORE: "memory",
      MNO_ALLOW_EPHEMERAL_NULLIFIERS: "1",
      MNO_ALLOW_UNAUTH_GATEWAY: "1",
      MNO_ALLOW_UNSIGNED_ORACLE: "1",
      MNO_ORACLE_SOURCE: source,
      ...over,
    },
  };
}

const countHandles = () => {
  const counts = {};
  for (const r of process.getActiveResourcesInfo()) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
};

test("importing the module boots nothing, and createGateway is the only way in", async () => {
  const before = countHandles();
  const mod = await import("../core/gateway.js");
  assert.deepEqual(Object.keys(mod).sort(), ["createGateway"], "the module exports the factory and nothing that runs");
  assert.equal(countHandles().TCPServerWrap ?? 0, before.TCPServerWrap ?? 0, "importing bound no socket");

  // THE OBSERVATION THAT DOES NOT DEPEND ON WHAT THIS PROCESS HAPPENS TO BE HOLDING. A child that
  // does nothing but import the module must run to completion on its own. A module-level boot would
  // stop that either way: a listening server holds the event loop open forever, and a boot refusal
  // rejects the import and exits non-zero. The environment given is one that boots successfully, so
  // a hang is the failure this actually hunts.
  //
  // AND A SIDE EFFECT THAT LEAVES NO HANDLE IS STILL A SIDE EFFECT. Exiting cleanly does not prove
  // an import touched nothing: opening the durable nullifier database creates a FILE and releases
  // its handle at exit, so the process would still finish. The child is therefore pointed at the
  // SQLite store with a path that does not exist yet, and the file's absence afterwards is what says
  // the import opened nothing.
  const { dir, env } = await envWithSnapshot({ MNO_STORE: "sqlite", MNO_ALLOW_EPHEMERAL_NULLIFIERS: "" });
  const dbPath = join(dir, "nullifiers.sqlite");
  const child = spawn(process.execPath, ["--input-type=module", "-e", 'await import(process.env.MNO_TEST_MODULE);'], {
    cwd: REPO,
    env: {
      ...process.env,
      ...env,
      MNO_NULLIFIER_PATH: dbPath,
      MNO_TEST_MODULE: new URL("../core/gateway.js", import.meta.url).href,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill();
        resolve("still running");
      }, 20_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    assert.equal(exited, 0, "a process that only imports the gateway exits on its own");
    assert.equal(existsSync(dbPath), false, "and it opened no durable store on the way");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() gives back every handle the boot took", async () => {
  const { dir, env } = await envWithSnapshot();
  const before = countHandles();
  const gateway = await createGateway({ config: buildConfig(env) });
  // A COPY, taken while the gateway still owns them, because close() empties the live list. Node's
  // own active-resource list cannot stand in here: these timers are unref'd, so they never appear
  // among the resources keeping the event loop alive. What it does answer is the socket.
  const timers = [...gateway.state.timers];
  try {
    assert.equal(gateway.server.listening, false, "the server is built but not listening: binding a port is the caller's call");
    assert.ok(timers.length >= 3, "the boot started its intervals, so there is something to give back");
    assert.ok(
      timers.every((t) => t.hasRef() === false),
      "and none of them holds the event loop open, so a caller that forgets close() leaks a timer rather than a process that never exits",
    );
    await gateway.listen(0);
    assert.equal(gateway.server.listening, true);
    assert.ok((countHandles().TCPServerWrap ?? 0) > (before.TCPServerWrap ?? 0), "the listening socket is a handle the process is holding");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
  assert.ok(timers.every((t) => t._destroyed === true), "close() stopped every timer it started");
  assert.equal(gateway.state.timers.length, 0);
  assert.equal(countHandles().TCPServerWrap ?? 0, before.TCPServerWrap ?? 0, "and left no socket behind");
  assert.equal(gateway.server.listening, false);
  await gateway.close(); // idempotent: a test that closes in a finally block and again at teardown is ordinary
});

test("a boot that fails releases the durable store it had already opened", async () => {
  // The nullifier store is opened well before the two-tier guards, the verification-key loads, and
  // the register-context validation. As a process that did not matter, since exiting hands the file
  // back. For a caller that catches the rejection it does: there is no handle, so an open database
  // would be unreachable until garbage collection.
  //
  // Observed on the SQLite store, because it is the one with a handle that can be seen to be open. A
  // second statement against a closed database throws, so the store the failed boot left behind is
  // asked to do work and must refuse.
  const { dir, env } = await envWithSnapshot({
    MNO_MODE: "two-tier",
    MNO_STORE: "sqlite",
    MNO_ALLOW_ANY_REGISTER_CONTEXTS: "1",
    // The failure: a two-tier boot cannot use a verification key that is not there. It happens after
    // the nullifier store is open, which is the whole point of the case.
    MNO_REG_VKEY: "/nonexistent/registration_vkey.json",
  });
  try {
    const config = buildConfig({ ...env, MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite") });
    // Capture the store the failed boot opened, so the assertion is about the HANDLE rather than
    // about close() having been called. A close() that recorded the call and released nothing would
    // satisfy a counter while leaving the database open, which is the defect itself.
    const { SqliteNullifierStore } = await import("../core/nullifier_sqlite.js");
    const opened = [];
    const realSize = SqliteNullifierStore.prototype.size;
    SqliteNullifierStore.prototype.size = function patched() {
      return realSize.call(this);
    };
    const realClose = SqliteNullifierStore.prototype.close;
    SqliteNullifierStore.prototype.close = function patched() {
      opened.push(this);
      return realClose.call(this);
    };
    try {
      await assert.rejects(createGateway({ config }), /ENOENT|no such file/, "the boot fails after the store is open");
      assert.equal(opened.length, 1, "the store the boot opened was closed on the way out");
      assert.throws(() => opened[0].size(), /finalized|not open/, "and the database really is released, not merely marked");
    } finally {
      SqliteNullifierStore.prototype.close = realClose;
      SqliteNullifierStore.prototype.size = realSize;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() is idempotent against the durable store, not only the in-memory one", async () => {
  // The first version of this contract was written and tested against MNO_STORE=memory, whose store
  // has no close() at all, so the second call was a no-op for a reason that had nothing to do with
  // the contract. The default store is SQLite, and closing that handle twice throws.
  const { dir, env } = await envWithSnapshot({ MNO_STORE: "sqlite" });
  const gateway = await createGateway({ config: buildConfig({ ...env, MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite") }) });
  try {
    const store = gateway.state.nullifiers;
    await gateway.close();
    assert.throws(() => store.size(), /finalized|not open/, "the teardown released the database, not just its bookkeeping");
    await gateway.close();
    await gateway.close();
    // AND THE STORE ITSELF, not only the gateway's bookkeeping. close() empties its release list as
    // it walks it, so repeat calls would be silent even if the store underneath still threw on a
    // second close. The store is closed by other paths too, so it has to hold the property on its own.
    store.close();
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a two-tier refresh cannot adopt after close(), whichever await close() lands inside", async () => {
  // The closed check was first placed after the oracle read, and the two-tier engine lookup right
  // behind it is ANOTHER await, so a close landing there still let the refresh adopt into a window
  // already given up. The check now sits after the last await, and this drives close() into exactly
  // that gap.
  const { dir, env } = await envWithSnapshot({
    MNO_MODE: "two-tier",
    MNO_ALLOW_ANY_REGISTER_CONTEXTS: "1",
    MNO_REG_PATH: join(tmpdir(), `mno-gw-mod-reg-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`),
  });
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    assert.equal(gateway.state.dmlRoots.current()?.root, ROOT, "the boot adopted the snapshot normally");
    // Empty the window, so anything in it after the racing refresh is that refresh's doing.
    gateway.state.dmlRoots.snaps.length = 0;
    assert.equal(gateway.state.dmlRoots.current(), null);

    // Hold the refresh inside the engine lookup, the await AFTER the read, and close() exactly
    // there. The close must not fire earlier: a close landing during the read is the case the
    // first check already handles, and a test that races into it proves nothing about this gap. So
    // the wrapper SIGNALS when the refresh is inside it, and the test closes only on that signal.
    let releaseLookup;
    const held = new Promise((resolve) => {
      releaseLookup = resolve;
    });
    let signalEntered;
    const entered = new Promise((resolve) => {
      signalEntered = resolve;
    });
    const store = gateway.state.registrationStore;
    const real = store.seasonHasEngine.bind(store);
    store.seasonHasEngine = async (...args) => {
      const r = await real(...args);
      signalEntered();
      await held;
      return r;
    };

    const inFlight = gateway.state.refreshRoots();
    await entered; // the read is done and its closed-check has passed; the refresh is in the gap
    const closing = gateway.close();
    releaseLookup();
    await closing;
    await inFlight;
    assert.equal(gateway.state.dmlRoots.current(), null, "the refresh adopted nothing into the closed window");
  } finally {
    await gateway.close();
    await rm(env.MNO_REG_PATH, { force: true });
    await rm(dir, { recursive: true, force: true });
  }
});

test("two close() calls racing share one teardown, so neither can strand the other mid-drain", async () => {
  // The failure this exists to prevent: the first close() starts draining the socket, listening goes
  // false, and a second close() sailing past that guard releases the stores while the first is still
  // waiting on an in-flight request that uses them. One shared teardown promise means both callers
  // await the same complete operation.
  const { dir, env } = await envWithSnapshot({ MNO_STORE: "sqlite" });
  const gateway = await createGateway({ config: buildConfig({ ...env, MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite") }) });
  try {
    const port = await gateway.listen(0);
    // A request already ANSWERING when the closes race, so the server genuinely has something to
    // drain. Awaited before closing, because a request that has not connected yet is refused rather
    // than drained and would prove nothing.
    const held = await fetch(`http://127.0.0.1:${port}/v1/health`);

    const first = gateway.close();
    const second = gateway.close();
    assert.equal(first, second, "every caller gets the same teardown promise, not their own partial one");
    await Promise.all([first, second, held.json()]);
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a closed gateway refuses to listen again rather than serving from released stores", async () => {
  // Node's HTTP server can be re-listened after close(), so nothing in the socket itself prevents
  // this. What it would produce is a gateway answering requests from a closed database with no
  // timers, and a later close() returning the already-settled teardown while the new socket stayed
  // open. The teardown is one-shot, so listening again is refused.
  const { dir, env } = await envWithSnapshot({ MNO_STORE: "sqlite" });
  const gateway = await createGateway({ config: buildConfig({ ...env, MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite") }) });
  try {
    await gateway.close();
    await assert.rejects(gateway.listen(0), /gateway is closed/, "after a teardown");
    assert.equal(gateway.server.listening, false, "and no socket was bound on the way to refusing");

    // Racing a teardown is the same answer, since close() marks the gateway closed before it awaits
    // anything.
    const second = await createGateway({ config: buildConfig({ ...env, MNO_NULLIFIER_PATH: join(dir, "second.sqlite") }) });
    await second.listen(0);
    const closing = second.close();
    await assert.rejects(second.listen(0), /gateway is closed/, "and during one");
    await closing;
    assert.equal(second.server.listening, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() waits for a request handler whose client has gone, not merely for the connection", async () => {
  // `server.close()` waits for CONNECTIONS to end. A client that disconnects mid-request ends its
  // connection while the handler keeps running, so a teardown that waits only on the server releases
  // the stores underneath work still using them. The observable end of that is a request path
  // reaching a finalized statement, which is a defect the caller never sees and the operator reads as
  // a mystery 400.
  const { dir, env } = await envWithSnapshot({ MNO_MODE: "two-tier", MNO_STORE: "sqlite", MNO_ALLOW_ANY_REGISTER_CONTEXTS: "1" });
  const gateway = await createGateway({
    config: buildConfig({ ...env, MNO_REG_PATH: join(dir, "reg.jsonl"), MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite") }),
  });
  try {
    const port = await gateway.listen(0);

    // Hold the challenge handler inside an await it really takes, then let the client vanish.
    let releaseHandler;
    const held = new Promise((resolve) => {
      releaseHandler = resolve;
    });
    let signalInside;
    const inside = new Promise((resolve) => {
      signalInside = resolve;
    });
    let storeUsableOnResume = null;
    const members = gateway.state.seasonMembers;
    const realEnsure = members.ensureContext.bind(members);
    members.ensureContext = async (...args) => {
      const r = await realEnsure(...args);
      signalInside();
      await held;
      // The store, used from inside a handler that resumed after the teardown was asked for. This is
      // the operation that threw "statement has been finalized" before close() waited for handlers.
      try {
        gateway.state.nullifiers.size();
        storeUsableOnResume = true;
      } catch {
        storeUsableOnResume = false;
      }
      return r;
    };

    const client = new AbortController();
    const request = fetch(`http://127.0.0.1:${port}/v1/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "p", communityId: "c", roleId: "r", account: "alice" }),
      signal: client.signal,
    }).catch(() => {});
    await inside;
    client.abort(); // the connection is gone; the handler is not
    await request;

    const closing = gateway.close();
    let closeReturned = false;
    closing.then(() => {
      closeReturned = true;
    });
    // THE OBSERVATION IS THAT close() HAS NOT RETURNED, checked before the handler is released rather
    // than after. Releasing first and then looking at the store is a race the correct code happens to
    // win: the handler's continuation is a microtask and would usually run before the release loop
    // even without any draining. A teardown that does not wait finishes an idle gateway in
    // milliseconds, so this margin is decisive rather than hopeful.
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(closeReturned, false, "close() did not return while a request handler was still running");

    releaseHandler();
    await closing;
    assert.equal(storeUsableOnResume, true, "and the handler still had its stores when it resumed");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() racing a bind waits for it, so no socket outlives the teardown", async () => {
  // A teardown that only closes a server it finds already listening releases everything and lets the
  // socket come up behind it, on a gateway with stopped timers and released stores, with the one-shot
  // teardown already settled and unable to close it.
  //
  // THE BIND IS MADE ASYNCHRONOUS ON PURPOSE, because a plain `server.listen(port)` with no host
  // binds synchronously on this platform and would not reach the case at all. The real deployments
  // where binding takes a turn are a cluster worker (the handle comes from the primary) and any
  // listen that resolves a hostname first. Deferring the underlying call models those without
  // needing either.
  const { dir, env } = await envWithSnapshot();
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    const realListen = gateway.server.listen.bind(gateway.server);
    gateway.server.listen = (...args) => {
      setTimeout(() => realListen(...args), 20);
      return gateway.server;
    };
    const listening = gateway.listen(0);
    assert.equal(gateway.server.listening, false, "the bind really is still in progress when close() is called");
    const closing = gateway.close();
    await listening.catch(() => {}); // the bind may succeed; either way it must not outlive the close
    await closing;
    assert.equal(gateway.server.listening, false, "the teardown closed the socket the pending bind opened");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("importing the config module validates nothing, so a malformed environment refuses at boot", async () => {
  // `export const config = buildConfig(process.env)` meant importing this module (and so importing
  // the gateway) validated the ambient environment: a malformed MNO_GATEWAY_PORT in the shell made
  // the import itself throw, before any caller could supply a config of its own.
  const mod = await import("../core/config.js");
  assert.deepEqual(Object.keys(mod).sort(), ["MAX_SNAPSHOT_SIGS", "buildConfig"], "no config is built at import");
  assert.throws(() => buildConfig({ MNO_GATEWAY_PORT: "not-an-integer" }), /must be an integer/, "the refusal happens when one is built");
});

test("every interval the boot starts is one close() can stop", async () => {
  // The timer list is only as good as the rule that every timer joins it. An untracked
  // `setInterval(...).unref()` would leave a callback running past close() and be invisible to the
  // active-resource count, which omits unreferenced timers. Counting the calls is what sees it.
  const { dir, env } = await envWithSnapshot({ MNO_MODE: "two-tier", MNO_ALLOW_ANY_REGISTER_CONTEXTS: "1" });
  const config = buildConfig({ ...env, MNO_REG_PATH: join(dir, "reg.jsonl") });
  const realSetInterval = globalThis.setInterval;
  let started = 0;
  globalThis.setInterval = (...args) => {
    started += 1;
    return realSetInterval(...args);
  };
  let gateway;
  try {
    gateway = await createGateway({ config });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  try {
    assert.ok(started > 0, "the boot starts intervals at all");
    assert.equal(gateway.state.timers.length, started, "and every one of them is tracked for teardown");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a release that throws does not stop the releases behind it", async () => {
  // Stopping at the first failure would leave the later acquisitions held forever, with the list
  // already emptied so no retry could reach them. Timers are registered FIRST, so they are released
  // LAST, which makes a failing store release the exact case that would strand them.
  const { dir, env } = await envWithSnapshot({ MNO_STORE: "sqlite" });
  const gateway = await createGateway({ config: buildConfig({ ...env, MNO_NULLIFIER_PATH: join(dir, "nullifiers.sqlite") }) });
  const timers = [...gateway.state.timers];
  try {
    const boom = new Error("store refused to close");
    gateway.state.nullifiers.close = () => {
      throw boom;
    };
    await assert.rejects(gateway.close(), (err) => err === boom, "the failure still reaches the caller");
    assert.ok(timers.every((t) => t._destroyed === true), "and the timers behind the failing store were still stopped");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("close() waits for a refresh already in flight, and that refresh adopts nothing after it", async () => {
  // Clearing an interval does not cancel a callback already running. A refresh whose read is
  // outstanding would otherwise go on to adopt a root into a window whose owner had already given it
  // up, after close() had returned and told the caller everything was released.
  const { dir, env } = await envWithSnapshot();
  const snapshot = await readFile(join(dir, "root.json"), "utf8");

  // A source whose response this test releases by hand, so a refresh really is in flight when close()
  // is called rather than merely started. Loopback HTTP is the one plain-HTTP case loadOracle allows.
  let releaseResponse;
  const held = new Promise((resolve) => {
    releaseResponse = resolve;
  });
  const oracle = createHttpServer(async (req, res) => {
    await held;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(snapshot);
  });
  await new Promise((resolve) => oracle.listen(0, "127.0.0.1", resolve));
  const heldUrl = `http://127.0.0.1:${oracle.address().port}/root.json`;

  // The gateway boots against a source that is not there, so it adopts nothing and the window is
  // empty. Whatever is in it afterwards came from the refresh this test controls.
  const config = buildConfig({ ...env, MNO_ORACLE_SOURCE: join(dir, "absent.json") });
  const gateway = await createGateway({ config });
  try {
    assert.equal(gateway.state.dmlRoots.current(), null, "the boot adopted nothing, so the window starts empty");
    config.oracleSource = heldUrl;

    let refreshFinished = false;
    const inFlight = gateway.state.refreshRoots().then(() => {
      refreshFinished = true;
    });
    await new Promise((resolve) => setImmediate(resolve)); // let the fetch actually start
    const closing = gateway.close();
    releaseResponse();
    await closing;
    // THE POINT OF WAITING, stated as the assertion. close() must not return while a refresh is
    // still running, or a caller told everything was released still has a fetch, an abort timer, and
    // a callback about to touch the root window. The response is released only after close() is
    // called, so a close that did not wait would resolve with this still false.
    assert.equal(refreshFinished, true, "close() returned only once the refresh in flight had finished");
    await inFlight;
    assert.equal(gateway.state.dmlRoots.current(), null, "and nothing was adopted into a window already given up");

    // And a refresh STARTED after close does no work at all.
    await gateway.state.refreshRoots();
    assert.equal(gateway.state.dmlRoots.current(), null, "a refresh after close() is a no-op");
  } finally {
    await gateway.close();
    await new Promise((resolve) => oracle.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test("listen() rejects when the port is taken rather than never settling", async () => {
  const { dir, env } = await envWithSnapshot();
  const first = await createGateway({ config: buildConfig(env) });
  const second = await createGateway({ config: buildConfig(env) });
  try {
    const port = await first.listen(0);
    await assert.rejects(second.listen(port), (err) => err.code === "EADDRINUSE", "the bind failure reaches the caller");
  } finally {
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the plain-HTTP oracle exception comes from the config, not from the ambient environment", async () => {
  // loadOracle used to read process.env.MNO_ORACLE_ALLOW_HTTP itself, which made it the one
  // security-bearing setting a supplied config could not control: a gateway built for an environment
  // that never opted in would still downgrade its transport because of a variable in the shell.
  const { loadOracle } = await import("../core/stores.js");
  const previous = process.env.MNO_ORACLE_ALLOW_HTTP;
  process.env.MNO_ORACLE_ALLOW_HTTP = "1";
  try {
    await assert.rejects(
      loadOracle("http://oracle.example/root.json", { allowHttp: false }),
      /must be https/,
      "the caller's answer decides, whatever the process environment says",
    );
  } finally {
    if (previous === undefined) delete process.env.MNO_ORACLE_ALLOW_HTTP;
    else process.env.MNO_ORACLE_ALLOW_HTTP = previous;
  }
  assert.equal(buildConfig({}).oracleAllowHttp, false, "and the config carries it, off unless asked for");
  assert.equal(buildConfig({ MNO_ORACLE_ALLOW_HTTP: "1" }).oracleAllowHttp, true);
});

test("the boot refusals are function behaviour now, not a process exit code", async () => {
  const { dir, env } = await envWithSnapshot();
  try {
    await assert.rejects(
      createGateway({ config: buildConfig({ ...env, MNO_ALLOW_UNAUTH_GATEWAY: "" }) }),
      /refusing to start unauthenticated/,
      "no adapter secret and no opt-in",
    );
    await assert.rejects(
      createGateway({ config: buildConfig({ ...env, MNO_ALLOW_UNSIGNED_ORACLE: "" }) }),
      /refusing to start with an unauthenticated oracle/,
      "a snapshot source with no pinned oracle key and no opt-in",
    );
    await assert.rejects(
      createGateway({ config: buildConfig({ ...env, MNO_ALLOW_EPHEMERAL_NULLIFIERS: "" }) }),
      /keeps the spent-nullifier set in memory/,
      "the ephemeral spent set without its opt-in",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the unsigned-oracle refusal is scoped to the snapshot source, so node mode boots without a key", async () => {
  // The refusal above exists because an unsigned SNAPSHOT would let any host serving the JSON forge a
  // membership set. In node mode there is no publisher and no snapshot, so demanding a pinned oracle
  // key is demanding a signature on data nobody published. The read itself fails here (no node is
  // configured in a test), which refreshRoots reports and swallows, so what this observes is that the
  // BOOT is not refused.
  const { dir, env } = await envWithSnapshot({ MNO_DML_SOURCE: "node", MNO_ALLOW_UNSIGNED_ORACLE: "" });
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    assert.equal(gateway.config.dmlSource, "node");
    assert.equal(gateway.state.dmlRoots.current(), null, "and it adopted nothing, since no node answered");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("every limiter that exists is actually swept, and the sweep is what the boot scheduled", async () => {
  // Three limiters were once left out of the periodic sweep and grew until the hard key ceiling
  // forced a synchronous one. Checking that a list contains what a map contains would not have caught
  // that: it says nothing about whether the sweep runs, or over which collection. So this charges
  // every named limiter, expires the windows, runs the sweep the gateway itself scheduled, and looks
  // at what is left.
  const { dir, env } = await envWithSnapshot({ MNO_RATE_WINDOW: "1" });
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    const named = Object.entries(gateway.state.limiters);
    assert.ok(named.length >= 8, "every request-facing endpoint has a limiter");
    for (const [name, limiter] of named) {
      limiter.allow(`key-for-${name}`);
      assert.equal(limiter.hits.size, 1, `${name} recorded the charge`);
      // Age the window out, which is what the sweep looks for.
      for (const entry of limiter.hits.values()) entry.reset = Date.now() - 1;
    }

    gateway.state.sweepLimiters();
    for (const [name, limiter] of named) assert.equal(limiter.hits.size, 0, `${name} was swept`);

    // And the periodic sweep the boot scheduled is this function, not some other one that happens to
    // be equivalent today.
    assert.ok(
      gateway.state.timers.some((t) => t._onTimeout === gateway.state.sweepLimiters),
      "one of the intervals the boot started runs the sweep",
    );
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function post(base, path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("a request the per-account limit refuses does not spend the shared bucket", async () => {
  // THE PROPERTY THAT PREVIOUSLY HAD TO BE PROVEN ONE LEVEL DOWN. Charging the two buckets in
  // sequence made a request refused by the second still cost the first, and both orderings of that
  // defect shipped. allowAll charges both or neither, and this drives the real /v1/challenge path to
  // say so rather than testing allowAll on its own.
  //
  // The account limit is the tight one (1 per window) and the shared per-source limit is 3. Alice
  // spends her single allowance, then is refused. If that refusal had charged the shared bucket, Bob
  // would find only one of the remaining two.
  const { dir, env } = await envWithSnapshot({ MNO_RATE_CHALLENGE_ACCOUNT: "1", MNO_RATE_CHALLENGE: "3", MNO_RATE_INGRESS: "1000" });
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    const port = await gateway.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const ask = (account) => post(base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account });

    assert.equal((await ask("alice")).status, 200, "alice's one allowance");
    assert.equal((await ask("alice")).status, 429, "and she is refused by her own limit");
    assert.equal((await ask("alice")).status, 429, "twice, so the refusals are not free either");

    assert.equal((await ask("bob")).status, 200, "the shared bucket has 2 left");
    assert.equal((await ask("carol")).status, 200, "and then 1");
    assert.equal((await ask("dave")).status, 429, "now the shared bucket is spent");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a request the shared bucket refuses does not spend the account's own allowance", async () => {
  // THE OTHER DIRECTION, and the one a short-circuiting sequential charge still gets wrong. Charging
  // the account bucket first and the shared bucket second means a caller the SHARED bucket turns
  // away has already paid from their personal allowance, so a busy community silently consumes each
  // member's own quota with requests nobody was served. Both orderings of this defect shipped, which
  // is why both directions are tested rather than the one that reads more naturally.
  //
  // The shared limit is 1 and the account limit is 3. Alice spends the community's single slot, is
  // refused twice, and then the shared bucket alone is released. What remains of her own allowance is
  // the observation: two if the refusals cost her nothing, none if each one did.
  const { dir, env } = await envWithSnapshot({ MNO_RATE_CHALLENGE_ACCOUNT: "3", MNO_RATE_CHALLENGE: "1", MNO_RATE_INGRESS: "1000" });
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    const port = await gateway.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const ask = () => post(base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });

    // Release the SHARED bucket only, leaving the per-account one exactly as the requests left it.
    // Reaching into the limiter is the point of the gateway being a module: the question is what a
    // REFUSED request charged, and no response can say. It is released before each probe because the
    // shared cap is one, so otherwise the shared bucket, not alice's allowance, decides the second
    // probe and the test would be measuring the wrong limiter.
    const releaseShared = () => gateway.state.limiters.challenge.hits.clear();

    assert.equal((await ask()).status, 200, "the community's single slot");
    assert.equal((await ask()).status, 429, "refused by the shared limit");
    assert.equal((await ask()).status, 429, "and again");

    releaseShared();
    assert.equal((await ask()).status, 200, "alice still has her allowance: the refusals cost her nothing");
    releaseShared();
    assert.equal((await ask()).status, 200, "two of three, so the count is exact rather than merely non-zero");
    releaseShared();
    assert.equal((await ask()).status, 429, "and the third exhausts it, so the limit still bites");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the challenge's signal is bound to the account it was minted for, which is what makes the check meaningful", async () => {
  // A DIRECT OBSERVATION, replacing a proxy. The previous version of this test posted a MALFORMED
  // fake proof and asserted the gateway answered account-mismatch. That proves the gateway compares
  // the submitted account with the stored one, which is worth having, but an external audit pointed
  // out it would pass unchanged if `account` were removed from signalHash() entirely, so it was
  // evidence for a weaker claim than its name made.
  //
  // The binding that matters is a cryptographic one. The signal a prover must commit to is derived
  // from the nonce AND the account, so a proof made for one account's challenge cannot satisfy another's
  // (review finding B1). That is checkable without any proof at all, by asking whether the signal the
  // gateway minted and stored is the one the account determines.
  const { dir, env } = await envWithSnapshot();
  const gateway = await createGateway({ config: buildConfig(env) });
  try {
    const port = await gateway.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const minted = await post(base, "/v1/challenge", { platform: "p", communityId: "c", roleId: "r", account: "alice" });
    assert.equal(minted.status, 200);

    const nonce = minted.body.nonce;
    assert.equal(
      minted.body.signalHash,
      signalHash(nonce, "alice").toString(),
      "the signal the prover must commit to is the one alice's account determines",
    );
    assert.notEqual(
      signalHash(nonce, "alice").toString(),
      signalHash(nonce, "mallory").toString(),
      "and another account on the SAME nonce yields a different signal, so a proof cannot carry across",
    );
    // The stored challenge holds that same signal, so the verifier compares against the bound value
    // rather than against something the caller sends.
    const stored = gateway.state.challenges.pending.get(nonce);
    assert.equal(stored.signalHash, signalHash(nonce, "alice").toString());
    assert.equal(stored.account, "alice");

    // And the gateway's own account check, the cheap guard in front of that binding. A submission
    // naming a different account is refused before any proof work, and it CONSUMES the one-time
    // nonce, since a nonce surviving a failed verify would be replayable.
    assert.equal(gateway.state.challenges.pending.size, 1, "one challenge is outstanding");
    const relayed = await post(base, "/v1/verify", {
      nonce,
      proof: { fake: true },
      publicSignals: ["1", "2", "3", "4"],
      account: "mallory",
    });
    assert.equal(relayed.status, 200);
    assert.equal(relayed.body.ok, false);
    assert.equal(relayed.body.reason, "account-mismatch");
    assert.equal(gateway.state.challenges.pending.size, 0, "and the one-time nonce was consumed by the attempt");
  } finally {
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  }
});
