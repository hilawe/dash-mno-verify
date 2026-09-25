import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/fetch_ptau.sh is the only gate between whatever a URL serves and the universal SRS every
// proving key is built from. The accept path needs the real 36 MB file and is exercised by the CI
// circuits job. These pin the REFUSE paths offline, using file:// sources so no network is touched.
// Every file here is fake, so every hash check must fail, and the point is what the script does then.

// fileURLToPath, not .pathname, which leaves a space in the checkout path percent-encoded.
const SCRIPT = fileURLToPath(new URL("../scripts/fetch_ptau.sh", import.meta.url));

function run(args, env = {}) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "fetch-ptau-"));
  const mirror = join(dir, "mirror");
  const upstream = join(dir, "upstream");
  execFileSync("mkdir", ["-p", mirror, upstream]);
  return {
    dir,
    mirror,
    upstream,
    // pathToFileURL escapes the path, so a temp directory with a space still yields a valid URL.
    env: { MNO_PTAU_BASE_URL: pathToFileURL(mirror).href, MNO_PTAU_UPSTREAM_BASE: pathToFileURL(upstream).href },
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const NAME15 = "powersOfTau28_hez_final_15.ptau";

test("an unsupported power is refused before anything is fetched", () => {
  const s = scratch();
  try {
    const r = run(["16", join(s.dir, "out.ptau")], s.env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unsupported power '16'/);
    assert.equal(existsSync(join(s.dir, "out.ptau")), false);
  } finally {
    s.done();
  }
});

test("a mirror serving the wrong bytes is refused, and nothing is left at the destination", () => {
  const s = scratch();
  try {
    writeFileSync(join(s.mirror, NAME15), "not the ceremony output");
    const dest = join(s.dir, "pot15.ptau");
    const r = run(["15", dest], s.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not match the published hash/);
    assert.match(r.stderr, /no source served a verified/);
    assert.equal(existsSync(dest), false, "a refused download must not land at the destination");
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.startsWith(".")), [], "no temp file is left behind");
  } finally {
    s.done();
  }
});

test("when the mirror fails, the upstream is tried and held to the same hash", () => {
  const s = scratch();
  try {
    // Nothing in the mirror, a wrong file upstream. The upstream fallback must not be a bypass.
    writeFileSync(join(s.upstream, NAME15), "also wrong");
    const dest = join(s.dir, "pot15.ptau");
    const r = run(["15", dest], s.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not download from file:\/\/.*mirror/);
    assert.match(r.stderr, /upstream.*does not match the published hash/);
    assert.equal(existsSync(dest), false);
  } finally {
    s.done();
  }
});

test("a cached file that fails the check is refused and left untouched, not replaced", () => {
  const s = scratch();
  try {
    const dest = join(s.dir, "pot15.ptau");
    writeFileSync(dest, "stale or tampered cache");
    const r = run(["15", dest], s.env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not match the published hash/);
    assert.equal(readFileSync(dest, "utf8"), "stale or tampered cache", "the operator's file is not deleted or overwritten");
  } finally {
    s.done();
  }
});

test("a destination that is a directory is refused, and nothing is written inside it", () => {
  // Before the fix, -f was false for a directory, so the download ran and `mv` put the verified file
  // INSIDE the directory, exiting 0 with nothing verified at the path the caller named.
  const s = scratch();
  try {
    const dest = join(s.dir, "pot15.ptau");
    mkdirSync(dest);
    writeFileSync(join(s.mirror, NAME15), "anything");
    const r = run(["15", dest], s.env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /exists and is not a regular file/);
    assert.deepEqual(readdirSync(dest), [], "nothing was moved into the directory");
  } finally {
    s.done();
  }
});

test("a symlink planted at the old fixed temp name cannot steer rejected bytes onto the destination", () => {
  // The temp file used to be "$DEST.download". A symlink there pointing at the absent destination made
  // curl write THROUGH it, and the cleanup then removed only the link, leaving the rejected bytes at
  // the destination. The temp file is now created exclusively under a random name.
  const s = scratch();
  try {
    const dest = join(s.dir, "pot15.ptau");
    symlinkSync(dest, `${dest}.download`);
    writeFileSync(join(s.mirror, NAME15), "rejected bytes");
    const r = run(["15", dest], s.env);
    assert.equal(r.code, 1);
    assert.equal(existsSync(dest), false, "the rejected bytes did not reach the destination");
  } finally {
    s.done();
  }
});

test("an interruption stops the run nonzero instead of falling through to the next source", async () => {
  // The old INT/TERM trap cleaned up and returned, so the loop carried on to the upstream source and
  // could exit 0. The mirror here is a loopback server that sends part of a body and holds the
  // connection, so the signal is sent only once the server has SEEN curl's request, which is proof
  // curl is running. Every wait is bounded, and on a timeout the whole process group (bash and curl)
  // is ended and awaited in finally, so the test cannot hang CI. Port 0 takes an ephemeral port, so it
  // cannot contend with the gateway tests.
  const s = scratch();
  const http = await import("node:http");
  let held = null;
  let child = null;
  let exited = null;
  let sawRequest;
  const requestSeen = new Promise((resolve) => (sawRequest = resolve));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("partial");
    held = res;
    sawRequest();
  });
  const within = (promise, ms, what) => {
    let timer;
    const expired = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)));
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    const dest = join(s.dir, "pot15.ptau");
    // detached makes bash a process-group leader, so cleanup can end curl along with it.
    child = spawn("bash", [SCRIPT, "15", dest], {
      env: { ...process.env, ...s.env, MNO_PTAU_BASE_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

    await within(requestSeen, 10_000, "curl's request to reach the mirror");
    child.kill("SIGTERM");
    // Let bash record the signal while it waits on curl, then drop the connection so curl returns.
    await new Promise((r) => setTimeout(r, 100));
    held.destroy();
    const code = await within(exited, 10_000, "the script to exit");
    assert.equal(code, 143, "TERM ends the run with 143");
    assert.doesNotMatch(out, /upstream/, "the run did not move on to the upstream source");
    assert.equal(existsSync(dest), false);
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.startsWith(".")), [], "no temp file is left behind");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // the group is already gone
      }
      await within(exited, 5_000, "the killed process group to exit").catch(() => {});
    }
    child?.stdout.destroy();
    child?.stderr.destroy();
    held?.destroy();
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    s.done();
  }
});

test("a destination that only becomes a directory once its parent is created is refused", () => {
  // "new/.." is not a directory until "new" exists. The check used to run before the parent was
  // created, so it passed, and the verified file then landed inside the directory with exit 0.
  const s = scratch();
  try {
    writeFileSync(join(s.mirror, NAME15), "anything");
    // Built as a raw string. path.join would normalize "new/.." away to the parent, which already
    // exists as a directory, and the test would then never exercise the ordering it is about.
    const dest = `${s.dir}/new/..`;
    const r = run(["15", dest], s.env);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /exists and is not a regular file/);
    assert.deepEqual(readdirSync(s.dir).filter((f) => f.startsWith(".")), [], "nothing was written into the directory");
  } finally {
    s.done();
  }
});
