import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import bs58check from "bs58check";
import { parseTwoTierArgs } from "../prover/two_tier_args.js";
import { leafFromPriv } from "../common/dml.js";
import { makeDmlRootHasher } from "../common/dml_root.js";
import { runScript } from "./run_script.mjs";

// prover/two_tier.js used to read its arguments strictly in `--flag value` pairs. The boolean
// --voting-key-stdin then swallowed the next word, which in the real run on 2026-09-26 silently
// dropped --secret-out, and the same flag placed last read as unset. These pin the parser and then the
// real CLI.

test("--voting-key-stdin followed by another flag no longer swallows it", () => {
  const { sub, values } = parseTwoTierArgs(["register", "--voting-key-stdin", "--secret-out", "/x.json", "--gateway", "g"]);
  assert.equal(sub, "register");
  assert.equal(values["voting-key-stdin"], true);
  assert.equal(values["secret-out"], "/x.json");
  assert.equal(values.gateway, "g");
});

test("--voting-key-stdin placed last is set, not read as absent", () => {
  const { values } = parseTwoTierArgs(["register", "--gateway", "g", "--voting-key-stdin"]);
  assert.equal(values["voting-key-stdin"], true);
});

test("the documented invocations parse to the values the CLI reads", () => {
  const r = parseTwoTierArgs(["register", "--gateway", "https://gw", "--platform", "discord", "--community", "1", "--role", "mn", "--voting-key-file", "key.wif"]);
  assert.deepEqual({ ...r.values }, { gateway: "https://gw", platform: "discord", community: "1", role: "mn", "voting-key-file": "key.wif" });
  const p = parseTwoTierArgs(["prove", "--gateway", "https://gw", "--challenge", "c.json", "--secret", "s.json", "--out", "p.json"]);
  assert.deepEqual({ ...p.values }, { gateway: "https://gw", challenge: "c.json", secret: "s.json", out: "p.json" });
});

test("malformed arguments are refused instead of silently dropped", () => {
  const refused = [
    ["register", "--secret-outt", "x"], // a typo
    ["prove", "--challenge"], // a value flag with no value
    ["prove", "--challenge", "c.json", "stray"], // a stray word
    ["prove", "--voting-key-file", "key.wif"], // a register-only flag given to prove
    ["register", "--voting-key-stdin=yes"], // a value given to a flag that takes none
  ];
  for (const argv of refused) {
    assert.throws(() => parseTwoTierArgs(argv), /ERR_PARSE_ARGS|Unknown option|argument missing|Unexpected argument|does not take an argument/i, argv.join(" "));
  }
});

test("a missing or unknown step returns no step, so the CLI prints its usage", () => {
  assert.equal(parseTwoTierArgs([]).sub, null);
  assert.equal(parseTwoTierArgs(["registr"]).sub, null);
  assert.equal(parseTwoTierArgs(["constructor"]).sub, null, "an inherited property name is not a step");
});

// The real CLI. `register` saves the member secret BEFORE it proves, so a fake gateway plus a working
// directory with no circuits/build lets the test see where the secret lands, and then the CLI fails fast
// on the missing proving key instead of running a ten-minute proof.
async function registerWithFakeGateway(extraArgsOrder) {
  const http = await import("node:http");
  const dir = mkdtempSync(join(tmpdir(), "two-tier-args-"));
  const priv = randomBytes(32);
  const wif = bs58check.encode(Buffer.concat([Buffer.from([0xef]), priv, Buffer.from([0x01])]));
  const leaves = [leafFromPriv(priv).toString()];
  const root = (await makeDmlRootHasher())(leaves);
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/v1/dml")) return res.end(JSON.stringify({ leaves, root }));
    if (req.url.startsWith("/v1/health")) return res.end(JSON.stringify({ season: 230 }));
    res.statusCode = 404;
    res.end("{}");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const gateway = `http://127.0.0.1:${server.address().port}`;
    const chosen = join(dir, "chosen.secret.json");
    const args = extraArgsOrder({ gateway, chosen });
    const cli = fileURLToPath(new URL("../prover/two_tier.js", import.meta.url));
    const quoted = args.map((a) => `'${a}'`).join(" ");
    writeFileSync(join(dir, "run.sh"), `cd "${dir}" && printf '%s\\n' '${wif}' | exec node "${cli}" register ${quoted}\n`);
    const r = await runScript(join(dir, "run.sh"), [], { timeoutMs: 30_000 });
    return { r, dir, chosen, files: readdirSync(dir) };
  } finally {
    server.closeAllConnections?.();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

const common = ({ gateway }) => ["--gateway", gateway, "--platform", "test", "--community", "c", "--role", "r"];

test("the real CLI honors --secret-out when it follows --voting-key-stdin", async () => {
  const { r, dir, chosen, files } = await registerWithFakeGateway((o) => [...common(o), "--voting-key-stdin", "--secret-out", o.chosen]);
  try {
    assert.equal(r.timedOut, false);
    assert.ok(existsSync(chosen), `the secret should be at --secret-out. Files: ${files.join(", ")}\n${r.stdout}${r.stderr}`);
    assert.deepEqual(files.filter((f) => f.startsWith("member.")), [], "nothing was written to the default name");
    assert.notEqual(r.code, 0, "it then fails on the missing proving key, as intended, rather than proving");
    assert.match(r.stderr, /ENOENT[^\n]*mno_registration\.wasm/, "and it fails for that reason, not another");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real CLI reads the key from stdin when --voting-key-stdin is the last flag", async () => {
  const { r, dir, chosen, files } = await registerWithFakeGateway((o) => [...common(o), "--secret-out", o.chosen, "--voting-key-stdin"]);
  try {
    assert.equal(r.timedOut, false);
    assert.ok(existsSync(chosen), `the key was read and the secret saved. Files: ${files.join(", ")}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /ENOENT[^\n]*mno_registration\.wasm/, "it got as far as proving, so the key was read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real CLI refuses an unknown option before doing anything", async () => {
  const dir = mkdtempSync(join(tmpdir(), "two-tier-args-"));
  try {
    const cli = fileURLToPath(new URL("../prover/two_tier.js", import.meta.url));
    writeFileSync(join(dir, "run.sh"), `cd "${dir}" && exec node "${cli}" register --gateway http://127.0.0.1:9 --secret-outt x\n`);
    const r = await runScript(join(dir, "run.sh"), [], { timeoutMs: 30_000 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown option '--secret-outt'/);
    assert.match(r.stderr, /usage:/);
    assert.deepEqual(readdirSync(dir).filter((f) => f !== "run.sh"), [], "nothing was written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
