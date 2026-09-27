import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync, readdirSync, symlinkSync, readlinkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runScript } from "./run_script.mjs";

// scripts/fetch_keys.sh reads keys.manifest.json from the directory above its own, so each test copies
// the real script into a scratch tree with a tiny manifest and serves the artifact from a file:// base.
// Nothing touches the network or the repository's own manifest.

const SCRIPT = fileURLToPath(new URL("../scripts/fetch_keys.sh", import.meta.url));

function tree({ content = "hello artifact", sha, large = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fetch-keys-"));
  const src = join(root, "hosted");
  mkdirSync(join(root, "scripts"));
  mkdirSync(src);
  copyFileSync(SCRIPT, join(root, "scripts", "fetch_keys.sh"));
  writeFileSync(join(src, "a.bin"), content);
  const digest = sha ?? createHash("sha256").update(content).digest("hex");
  const entry = { name: "a.bin", dest: "out/a.bin", sha256: digest };
  const manifest = large
    ? { tag: "t", files: [], largeFiles: [{ ...entry, url: `${pathToFileURL(src).href}/a.bin` }] }
    : { tag: "t", files: [entry], largeFiles: [] };
  writeFileSync(join(root, "keys.manifest.json"), JSON.stringify(manifest));
  return { root, env: { MNO_KEYS_BASE_URL: pathToFileURL(src).href }, done: () => rmSync(root, { recursive: true, force: true }) };
}

// Temp files are created as ".<dest basename>.XXXXXX" beside the destination.
const tempFiles = (t) => (existsSync(join(t.root, "out")) ? readdirSync(join(t.root, "out")).filter((f) => f.startsWith(".")) : []);

function writeManifest(t, m) {
  writeFileSync(join(t.root, "keys.manifest.json"), typeof m === "string" ? m : JSON.stringify(m));
}

async function run(t, args = []) {
  const r = await runScript(join(t.root, "scripts", "fetch_keys.sh"), args, { env: t.env });
  assert.equal(r.timedOut, false, "the script hung past its deadline");
  return r;
}

test("a fully successful fetch exits 0, not only prints that it succeeded", async () => {
  // The EXIT trap's last command used to be `[ -n "$CURRENT_TMP" ] && rm`, false with nothing in
  // flight, so every successful run exited 1 and anything chained after it with && never ran.
  const t = tree();
  try {
    const r = await run(t);
    assert.match(r.stdout, /All requested artifacts fetched and verified/);
    assert.equal(r.code, 0, "success must be reported as exit 0");
    assert.equal(readFileSync(join(t.root, "out/a.bin"), "utf8"), "hello artifact");
  } finally {
    t.done();
  }
});

test("--large with a hosted entry also exits 0", async () => {
  const t = tree({ large: true });
  try {
    const r = await run(t, ["--large"]);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(join(t.root, "out/a.bin"), "utf8"), "hello artifact");
  } finally {
    t.done();
  }
});

test("a checksum mismatch exits 1 and leaves nothing at the destination", async () => {
  const t = tree({ sha: "0".repeat(64) });
  try {
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /CHECKSUM MISMATCH/);
    assert.equal(existsSync(join(t.root, "out/a.bin")), false);
    assert.deepEqual(tempFiles(t), [], "the temp file is cleaned up");
  } finally {
    t.done();
  }
});

test("a large entry's own url wins over MNO_KEYS_BASE_URL", async () => {
  // The file exists ONLY at the explicit url. The base points at an empty directory, so the fetch
  // succeeds only if the per-entry url is the one used.
  const t = tree({ large: true });
  try {
    const empty = join(t.root, "empty");
    mkdirSync(empty);
    t.env.MNO_KEYS_BASE_URL = pathToFileURL(empty).href;
    const r = await run(t, ["--large"]);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(readFileSync(join(t.root, "out/a.bin"), "utf8"), "hello artifact");
  } finally {
    t.done();
  }
});

test("a failed download exits 1 and names the source", async () => {
  const t = tree();
  try {
    t.env.MNO_KEYS_BASE_URL = pathToFileURL(join(t.root, "nowhere")).href;
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /could not download a\.bin from file:/);
    assert.equal(existsSync(join(t.root, "out/a.bin")), false);
  } finally {
    t.done();
  }
});

test("an unhosted large entry (no sha256) exits 1 with the rebuild instructions", async () => {
  const t = tree({ large: true });
  try {
    const m = JSON.parse(readFileSync(join(t.root, "keys.manifest.json"), "utf8"));
    m.largeFiles[0].sha256 = "";
    writeFileSync(join(t.root, "keys.manifest.json"), JSON.stringify(m));
    const r = await run(t, ["--large"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /is not hosted yet/);
  } finally {
    t.done();
  }
});

test("a checksum mismatch leaves an existing good file untouched", async () => {
  const t = tree({ sha: "0".repeat(64) });
  try {
    mkdirSync(join(t.root, "out"));
    writeFileSync(join(t.root, "out/a.bin"), "the good copy already here");
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.equal(readFileSync(join(t.root, "out/a.bin"), "utf8"), "the good copy already here");
  } finally {
    t.done();
  }
});

test("an interruption stops the run with 143 instead of moving on to the next file", async () => {
  // Two files, served by a loopback server that holds the first response open. TERM is sent only once
  // the server has seen curl's request. The old trap cleaned up and returned, so the loop went on to
  // request the second file. Every wait is bounded and the process group is ended in finally.
  const t = tree();
  const m = JSON.parse(readFileSync(join(t.root, "keys.manifest.json"), "utf8"));
  m.files.push({ name: "b.bin", dest: "out/b.bin", sha256: "0".repeat(64) });
  writeFileSync(join(t.root, "keys.manifest.json"), JSON.stringify(m));
  const http = await import("node:http");
  const requests = [];
  let held = null;
  let sawFirst;
  const firstSeen = new Promise((resolve) => (sawFirst = resolve));
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-length": "1000" });
    res.write("partial");
    held = res;
    sawFirst();
  });
  const within = (promise, ms, what) => {
    let timer;
    const expired = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)));
    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
  };
  let child = null;
  let exited = null;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    child = spawn("bash", [join(t.root, "scripts", "fetch_keys.sh")], {
      env: { ...process.env, MNO_KEYS_BASE_URL: `http://127.0.0.1:${port}` },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.resume();
    child.stderr.resume();
    exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
    await within(firstSeen, 10_000, "curl's first request");
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    held.destroy();
    const code = await within(exited, 10_000, "the script to exit");
    assert.equal(code, 143);
    assert.deepEqual(requests, ["/a.bin"], "the second file was never requested");
    assert.equal(existsSync(join(t.root, "out/a.bin")), false);
    assert.deepEqual(tempFiles(t), [], "the partial temp file is cleaned up");
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
    t.done();
  }
});

test("a symlink planted at the old fixed temp name cannot steer rejected bytes onto the destination", async () => {
  // The temp file used to be "$dest.download", shared by every run. A link there pointing at the absent
  // destination made curl write THROUGH it, and the cleanup then removed only the link, leaving the
  // rejected bytes in place. Two concurrent runs shared the same name for the same reason. The temp
  // file is now created exclusively under a random name.
  const t = tree({ sha: "0".repeat(64) });
  try {
    mkdirSync(join(t.root, "out"));
    symlinkSync(join(t.root, "out/a.bin"), join(t.root, "out/a.bin.download"));
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.equal(existsSync(join(t.root, "out/a.bin")), false, "the rejected bytes did not reach the destination");
  } finally {
    t.done();
  }
});

test("a destination that is a directory is refused, and nothing is put inside it", async () => {
  const t = tree();
  try {
    mkdirSync(join(t.root, "out/a.bin"), { recursive: true });
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /exists and is not a regular file/);
    assert.deepEqual(readdirSync(join(t.root, "out/a.bin")), []);
  } finally {
    t.done();
  }
});

for (const [label, manifest] of [
  ["no files list", { tag: "t" }],
  ["a null entry", { tag: "t", files: [null] }],
  ["a small entry with no sha256", { tag: "t", files: [{ name: "a.bin", dest: "out/a.bin" }] }],
  ["a name containing the field separator", { tag: "t", files: [{ name: "a\u001fx", dest: "out/a.bin", sha256: "0".repeat(64) }] }],
  ["a dest containing a line break", { tag: "t", files: [{ name: "a.bin", dest: "out/a\nb", sha256: "0".repeat(64) }] }],
  ["a dest containing NUL", { tag: "t", files: [{ name: "a.bin", dest: "out/a\u0000b", sha256: "0".repeat(64) }] }],
]) {
  test(`a malformed manifest (${label}) refuses instead of reporting success`, async () => {
    // These used to make the list producer throw inside a process substitution nobody checked, so the
    // loop saw no entries and the script printed that everything was verified.
    const t = tree();
    try {
      writeManifest(t, manifest);
      const r = await run(t);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /keys\.manifest\.json is malformed/);
      assert.doesNotMatch(r.stdout, /fetched and verified/);
      assert.equal(existsSync(join(t.root, "out")), false, "nothing was fetched");
    } finally {
      t.done();
    }
  });
}

test("failure advice for an entry with no url names the base it was fetched from", async () => {
  const t = tree({ large: true });
  try {
    const m = JSON.parse(readFileSync(join(t.root, "keys.manifest.json"), "utf8"));
    delete m.largeFiles[0].url;
    writeManifest(t, m);
    t.env.MNO_KEYS_BASE_URL = pathToFileURL(join(t.root, "nowhere")).href;
    const r = await run(t, ["--large"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /This entry is fetched from file:/);
    assert.doesNotMatch(r.stdout, /its own url/);
  } finally {
    t.done();
  }
});

test("failure advice for a small entry with its own url says MNO_KEYS_BASE_URL does not redirect it", async () => {
  const t = tree();
  try {
    const m = JSON.parse(readFileSync(join(t.root, "keys.manifest.json"), "utf8"));
    m.files[0].url = pathToFileURL(join(t.root, "nowhere", "a.bin")).href;
    writeManifest(t, m);
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /fetched from its own url/);
  } finally {
    t.done();
  }
});

test("a symlink at the destination is refused, and neither the link nor its target is changed", async () => {
  // The rename would replace the link itself, silently undoing an operator's choice to keep the key
  // elsewhere. A link to a regular file passed the old regular-file test because -f follows links.
  const t = tree();
  try {
    mkdirSync(join(t.root, "out"));
    const target = join(t.root, "elsewhere.bin");
    writeFileSync(target, "kept elsewhere");
    symlinkSync(target, join(t.root, "out/a.bin"));
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /is not a regular file/);
    assert.equal(readlinkSync(join(t.root, "out/a.bin")), target, "the link is still there");
    assert.equal(readFileSync(target, "utf8"), "kept elsewhere");
  } finally {
    t.done();
  }
});

test("a dangling symlink at the destination is refused rather than replaced", async () => {
  const t = tree();
  try {
    mkdirSync(join(t.root, "out"));
    symlinkSync(join(t.root, "missing.bin"), join(t.root, "out/a.bin"));
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.equal(lstatSync(join(t.root, "out/a.bin")).isSymbolicLink(), true, "the link was not replaced");
  } finally {
    t.done();
  }
});

test("a failed chmod refuses instead of installing a file other accounts cannot read", async () => {
  // fetch_one runs as an `if !` condition, which turns set -e off inside it, so an unchecked chmod
  // failure used to be ignored and a mode-0600 file installed with exit 0. A chmod shim that always
  // fails stands in for the failure.
  const t = tree();
  try {
    const bin = join(t.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "chmod"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    t.env.PATH = `${bin}:${process.env.PATH}`;
    const r = await run(t);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /could not set permissions/);
    assert.equal(existsSync(join(t.root, "out/a.bin")), false);
    assert.deepEqual(tempFiles(t), []);
  } finally {
    t.done();
  }
});

test("a symlink created at the destination DURING the download is refused, not replaced", async () => {
  // The first check runs before the download. A loopback server sends part of the body, the test then
  // plants a link at the destination, and the server finishes with the correct bytes, so the only
  // thing that can stop the install is the re-check just before the rename.
  const t = tree();
  const http = await import("node:http");
  const body = Buffer.from("hello artifact");
  let held = null;
  let sawRequest;
  const requestSeen = new Promise((resolve) => (sawRequest = resolve));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-length": String(body.length) });
    res.write(body.subarray(0, 3));
    held = res;
    sawRequest();
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.env.MNO_KEYS_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const result = run(t);
    await requestSeen;
    const target = join(t.root, "elsewhere.bin");
    writeFileSync(target, "kept elsewhere");
    symlinkSync(target, join(t.root, "out/a.bin"));
    held.end(body.subarray(3));
    const r = await result;
    assert.equal(r.code, 1);
    assert.match(r.stdout, /changed during the download/);
    assert.equal(readlinkSync(join(t.root, "out/a.bin")), target, "the link is still there");
    assert.equal(readFileSync(target, "utf8"), "kept elsewhere");
    assert.deepEqual(tempFiles(t), []);
  } finally {
    held?.destroy();
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    t.done();
  }
});

// Review finding F4. A member needs one large key, not both, a verified file need not be fetched
// again, a download that cannot fit is refused before it starts, and a transient error is retried.
function twoLargeTree({ bytes = 5 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "fetch-keys-large-"));
  const src = join(root, "hosted");
  mkdirSync(join(root, "scripts"));
  mkdirSync(src);
  copyFileSync(SCRIPT, join(root, "scripts", "fetch_keys.sh"));
  const entries = ["mno_registration.zkey", "mno_membership.zkey"].map((name) => {
    const content = `content of ${name}`;
    writeFileSync(join(src, name), content);
    return { name, dest: `out/${name}`, sha256: createHash("sha256").update(content).digest("hex"), bytes };
  });
  writeFileSync(join(root, "keys.manifest.json"), JSON.stringify({ tag: "t", files: [], largeFiles: entries }));
  return { root, env: { MNO_KEYS_BASE_URL: pathToFileURL(src).href }, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("--large registration fetches only the registration key, and --large membership only the other", async () => {
  for (const [which, want, skip] of [["registration", "mno_registration.zkey", "mno_membership.zkey"], ["membership", "mno_membership.zkey", "mno_registration.zkey"]]) {
    const t = twoLargeTree();
    try {
      const r = await run(t, ["--large", which]);
      assert.equal(r.code, 0, r.stdout);
      assert.ok(existsSync(join(t.root, "out", want)), `${want} fetched`);
      assert.equal(existsSync(join(t.root, "out", skip)), false, `${skip} not fetched`);
    } finally {
      t.done();
    }
  }
});

test("contrary: --large alone still fetches both keys", async () => {
  const t = twoLargeTree();
  try {
    const r = await run(t, ["--large"]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(readdirSync(join(t.root, "out")).filter((f) => !f.startsWith(".")).sort(), ["mno_membership.zkey", "mno_registration.zkey"]);
  } finally {
    t.done();
  }
});

test("an unknown key name or extra argument is refused with the usage", async () => {
  const t = twoLargeTree();
  try {
    for (const args of [["--large", "both"], ["--large", "registration", "extra"], ["--larg"]]) {
      const r = await run(t, args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.stdout, /usage:/);
    }
    assert.equal(existsSync(join(t.root, "out")), false, "nothing was fetched");
  } finally {
    t.done();
  }
});

test("a file already present with the right checksum is skipped, even with the source unreachable", async () => {
  const t = twoLargeTree();
  try {
    assert.equal((await run(t, ["--large", "registration"])).code, 0);
    t.env.MNO_KEYS_BASE_URL = pathToFileURL(join(t.root, "nowhere")).href;
    const r = await run(t, ["--large", "registration"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /mno_registration\.zkey already present and verified, skipped/);
  } finally {
    t.done();
  }
});

test("a download larger than the free disk is refused before anything is fetched", async () => {
  const t = twoLargeTree({ bytes: 1e15 }); // a petabyte each, more than any test machine has free
  try {
    const r = await run(t, ["--large", "registration"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not enough free disk/);
    // The size line itself, which a quoting slip once printed empty while the check still ran.
    assert.match(r.stdout, /about \d+\.\d{2} GB to download into \S+, \d+\.\d{2} GB free there/);
    assert.equal(existsSync(join(t.root, "out")), false, "nothing was downloaded");
  } finally {
    t.done();
  }
});

test("a transient server error is retried rather than failing the download", async () => {
  const http = await import("node:http");
  const t = tree();
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (hits === 1) {
      res.statusCode = 503;
      return res.end("try later");
    }
    res.end("hello artifact");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.env.MNO_KEYS_BASE_URL = `http://127.0.0.1:${server.address().port}`;
    const r = await run(t);
    assert.equal(r.code, 0, r.stdout);
    assert.ok(hits >= 2, "the first 503 was retried");
    assert.equal(readFileSync(join(t.root, "out/a.bin"), "utf8"), "hello artifact");
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    t.done();
  }
});

test("free space is measured where the key is written, not where the repository is", async () => {
  // A review found the check read the repository's filesystem, so a key directory on a fuller volume
  // passed. A stand-in df reports plenty everywhere except the key directory, which it reports as
  // nearly full. The download must be refused. Measured at the repository root, it would pass.
  const t = twoLargeTree({ bytes: 1_000_000 });
  try {
    const m = JSON.parse(readFileSync(join(t.root, "keys.manifest.json"), "utf8"));
    for (const e of m.largeFiles) e.dest = `keydir-elsewhere/${e.name}`;
    writeFileSync(join(t.root, "keys.manifest.json"), JSON.stringify(m));
    mkdirSync(join(t.root, "keydir-elsewhere"));
    const bin = join(t.root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "df"),
      [
        "#!/bin/sh",
        'for a; do p="$a"; done',
        'echo "Filesystem 1024-blocks Used Available Capacity Mounted"',
        'case "$p" in *keydir-elsewhere*) echo "fake 100 99 1 99% /keys" ;; *) echo "fake 999999999 0 999999999 0% /" ;; esac',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    t.env.PATH = `${bin}:${process.env.PATH}`;
    const r = await run(t, ["--large", "registration"]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /not enough free disk in keydir-elsewhere/);
    assert.deepEqual(readdirSync(join(t.root, "keydir-elsewhere")), [], "nothing was downloaded");
  } finally {
    t.done();
  }
});

test("realistic key sizes are summed exactly, so a disk that holds one key but not both is refused", async () => {
  // Both keys at their real sizes total 4,566,610,976 bytes. A stand-in df reports 3.5 GB free, enough
  // for one key and not for both. A review found Debian's default awk printed that total with %d as
  // 2,147,483,647, which would have let this download start. Run this where awk is mawk to see it.
  const t = twoLargeTree();
  try {
    const m = JSON.parse(readFileSync(join(t.root, "keys.manifest.json"), "utf8"));
    m.largeFiles[0].bytes = 2283307972;
    m.largeFiles[1].bytes = 2283303004;
    writeFileSync(join(t.root, "keys.manifest.json"), JSON.stringify(m));
    const bin = join(t.root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "df"), ["#!/bin/sh", 'echo "Filesystem 1024-blocks Used Available Capacity Mounted"', 'echo "fake 9999999 0 3417968 1% /"', ""].join("\n"), { mode: 0o755 });
    t.env.PATH = `${bin}:${process.env.PATH}`;
    const r = await run(t, ["--large"]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /about 4\.57 GB to download/);
    assert.match(r.stdout, /not enough free disk/);
  } finally {
    t.done();
  }
});
