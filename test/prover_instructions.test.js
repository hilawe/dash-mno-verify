import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { proveInstructions, proveSteps, VOTING_KEY_FILE } from "../common/prover_instructions.js";
import { parseTwoTierArgs } from "../prover/two_tier_args.js";

// Pin the prover steps the adapters show. Every command must be copy-pasteable, so the gateway URL,
// platform, community, and role are filled in from the adapter's context (a wrong guess would register
// into a tree that does not satisfy the challenge), and the member's own voting-key file has a fixed
// name the setup guide tells them to create, so nothing is left to fill in. The single-tier prover
// reads the oracle locally, so it needs none of it.
const CTX = { gateway: "https://gw.example", platform: "discord", community: "C123", role: "R456" };
const commands = (lines) => lines.filter((l) => l.startsWith("npm run "));
const argsOf = (cmd) => cmd.split(" -- ")[1].split(" ");

test("two-tier puts registration BEFORE the challenge-bound proof (review finding F2)", () => {
  const lines = proveInstructions("two-tier", CTX);
  const register = lines.findIndex((l) => l.startsWith("npm run register "));
  const prove = lines.findIndex((l) => l.startsWith("npm run prove-epoch "));
  assert.ok(register >= 0 && prove >= 0, "both steps are shown");
  assert.ok(register < prove, "registration comes first, so a first-timer does not burn the challenge on it");
  assert.match(lines.slice(0, register).join(" "), /needs no challenge/i);
  assert.match(lines.slice(0, register).join(" "), /fresh challenge/i, "and requests a new challenge afterwards");
});

test("every command starts with npm run and every note does not, so adapters can render them apart", () => {
  for (const mode of ["single", "two-tier"]) {
    const lines = proveInstructions(mode, CTX);
    assert.ok(commands(lines).length >= 1);
    for (const l of lines) if (!l.startsWith("npm run ")) assert.doesNotMatch(l, /--[a-z]/, `a note carries a flag: ${l}`);
  }
});

test("two-tier fills in the concrete gateway, platform, community, and role", () => {
  const [register, prove] = commands(proveInstructions("two-tier", CTX));
  assert.match(prove, /^npm run prove-epoch -- /);
  assert.match(prove, /--gateway https:\/\/gw\.example/);
  assert.match(prove, /--challenge challenge\.json/);
  // No --secret on purpose. Registration names the secret per (platform, community, role, season),
  // so no single filename is printable here, and passing one switches the prover out of the context
  // lookup that finds the real file.
  assert.doesNotMatch(prove, /--secret/, "an explicit --secret disables the prover's context lookup");
  assert.match(register, /^npm run register -- /);
  for (const part of ["--gateway https://gw.example", "--platform discord", "--community C123", "--role R456", "--voting-key-file voting-key.txt"]) {
    assert.ok(register.includes(part), `register is missing ${part}`);
  }
  for (const line of [prove, register]) {
    const unfilled = line.match(/<[^>]+>/g) ?? [];
    assert.deepEqual(unfilled, [], `unfilled placeholders in: ${line}`);
  }
});

test("no step passes the voting key as a bare argument, where shell history and ps would keep it", () => {
  for (const mode of ["single", "two-tier"]) {
    for (const cmd of commands(proveInstructions(mode, CTX))) {
      assert.doesNotMatch(cmd, /--voting-key(\s|=)/, `bare --voting-key in: ${cmd}`);
      assert.doesNotMatch(cmd, /<WIF>/);
    }
  }
});

test("the displayed two-tier commands parse with the real two_tier option parser", () => {
  const [register, prove] = commands(proveInstructions("two-tier", CTX));
  const r = parseTwoTierArgs(["register", ...argsOf(register)]);
  assert.equal(r.values["voting-key-file"], VOTING_KEY_FILE);
  assert.equal(r.values.community, "C123");
  const p = parseTwoTierArgs(["prove", ...argsOf(prove)]);
  assert.equal(p.values.challenge, "challenge.json");
});

test("the displayed single-tier command parses with the real prover CLI", () => {
  // Run prover/prover.js with exactly the displayed arguments, the key placeholder pointed at a path
  // that does not exist. A flag the CLI does not know stops at parsing with "Unknown option". Parsed
  // arguments get as far as reading the challenge file, which is missing here, so no proof is attempted.
  const [cmd] = commands(proveInstructions("single", CTX));
  const dir = mkdtempSync(join(tmpdir(), "instr-"));
  try {
    const args = argsOf(cmd).map((a) => (a === VOTING_KEY_FILE ? join(dir, VOTING_KEY_FILE) : a));
    const cli = fileURLToPath(new URL("../prover/prover.js", import.meta.url));
    let stderr = "";
    try {
      execFileSync("node", [cli, ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
    } catch (e) {
      stderr = String(e.stderr ?? "");
    }
    assert.doesNotMatch(stderr, /Unknown option|ERR_PARSE_ARGS/, stderr);
    assert.match(stderr, /ENOENT[^\n]*challenge\.json/, "it parsed and went on to read the challenge");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Either the command names no secret at all (the supported form, the prover looks it up from the
// challenge) or it names a path registration actually produces. Anything else strands every two-tier
// member who follows the instructions, which is what a hardcoded `member.secret.json` once did.
test("the prove command never names a secret file registration would not have created", async () => {
  const { defaultSecretPath } = await import("../prover/secret_file.js");
  const [, prove] = commands(proveInstructions("two-tier", CTX));
  const named = prove.match(/--secret\s+(\S+)/)?.[1];
  if (named == null) return;
  const producible = [0, 1, 7, 42].map((season) =>
    defaultSecretPath({ platform: CTX.platform, community: CTX.community, role: CTX.role, season }),
  );
  assert.ok(producible.includes(named), `--secret ${named} is not a path registration ever writes`);
});

test("two-tier without context falls back to angle-bracket placeholders", () => {
  assert.match(commands(proveInstructions("two-tier"))[0], /--gateway <gateway-url>/);
});

test("an unknown mode falls back to the single-tier steps", () => {
  assert.deepEqual(proveInstructions(undefined, CTX), proveInstructions("single"));
});

// Found in the Discord pilot (2026-09-29). An adapter on the gateway's host passed its own loopback
// address, and the instructions told members to connect to their own computer. An adapter that knows
// no member-facing address passes null, and the command must then show a placeholder, not an address.
test("a null gateway prints the placeholder rather than an address", () => {
  const { register, prove } = proveSteps("two-tier", { ...CTX, gateway: null });
  assert.match(register, /--gateway <gateway-url> /);
  assert.match(prove, /--gateway <gateway-url> /);
  assert.doesNotMatch(register + prove, /127\.0\.0\.1|localhost/);
});

test("the instruction lines carry exactly the commands proveSteps gives, in order", () => {
  for (const mode of ["single", "two-tier"]) {
    const { register, prove } = proveSteps(mode, CTX);
    assert.deepEqual(commands(proveInstructions(mode, CTX)), [register, prove].filter(Boolean));
  }
});

test("a setup guide link is appended in two-tier mode when the adapter has one, and omitted otherwise", () => {
  const withGuide = proveInstructions("two-tier", { ...CTX, guide: "https://example.org/guide" });
  assert.equal(withGuide.at(-1), "New to this? The setup guide is at https://example.org/guide");
  assert.ok(!proveInstructions("two-tier", CTX).some((l) => /setup guide/.test(l)));
  // The guide covers the two-tier setup only, so a single-tier member is not sent to it.
  assert.ok(!proveInstructions("single", { ...CTX, guide: "https://example.org/guide" }).some((l) => /setup guide/.test(l)));
});
