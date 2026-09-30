// Loads the REAL adapters/telegram/bot.js with its outside services replaced, drives its /verify and
// document handlers in each chat type, and prints what they did as JSON. Run by
// test/telegram_private_only.test.js under --experimental-vm-modules (node:vm SourceTextModule), which is
// what lets the module's own imports be substituted without editing it. Nothing here reaches Telegram,
// a gateway, or a file server.
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = "adapters/telegram/bot.js";
const challenge = { mode: "two-tier", nonce: "n", signalHash: "1", epoch: 1, root: "2", contextHash: "3", season: 1, challengeExpiresAt: 1790700600, accessEndsAt: 1796256000, seasonEndsAt: 1796256000 };

const record = { fetches: [], fileFetches: 0, getFileCalls: 0, replies: [] };
let verifyResponse = { ok: true, status: 200, body: { ok: true, expiresAt: 1796256000 } };
const commands = {};
const handlers = {};
class Bot {
  constructor() { this.api = {}; }
  command(name, fn) { commands[name] = fn; }
  on(name, fn) { handlers[name] = fn; }
  catch() {}
  start() {}
}
class InputFile { constructor(buf, name) { this.name = name; } }
class GrantLedger { some() { return false; } async sweep() { return []; } async grant() {} }
const env = {
  MNO_GATEWAY_URL: "https://verify.example.org",
  TELEGRAM_BOT_TOKEN: "not-a-real-token",
  TELEGRAM_GROUP_ID: "-1001234567890",
};
const sandbox = vm.createContext({
  console: { log() {}, warn() {}, error() {} },
  Buffer, URL, setTimeout,
  setInterval: () => ({ unref() {} }),
  fetch: async (url) => {
    record.fetches.push(String(url));
    if (String(url).endsWith("/v1/challenge")) return { ok: true, json: async () => challenge };
    if (String(url).endsWith("/v1/verify")) return { ok: verifyResponse.ok, status: verifyResponse.status, json: async () => verifyResponse.body };
    return { ok: true, json: async () => ({}) };
  },
});

const mod = new vm.SourceTextModule(readFileSync(resolve(repo, rel), "utf8"), { context: sandbox, identifier: rel });
await mod.link(async (spec) => {
  let values;
  if (spec === "grammy") values = { Bot, InputFile };
  else if (spec === "node:process") values = { default: { env } };
  else if (spec.endsWith("/bounded_fetch.js")) values = { MAX_PROOF_BYTES: 65536, fetchJsonCapped: async () => (record.fileFetches++, { nonce: "n", proof: {}, publicSignals: [] }) };
  else if (spec.endsWith("/grant_ledger.js")) values = { GrantLedger };
  else if (spec.endsWith("/reconcile.js")) values = { requireReconciled: async () => {}, markReconciled: async () => {}, reconciliationDone: async () => true };
  else values = spec.startsWith(".") ? await import(pathToFileURL(resolve(repo, dirname(rel), spec))) : await import(spec);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const k of Object.keys(values)) this.setExport(k, values[k]);
  }, { context: sandbox });
});
await mod.evaluate();

const out = {};
for (const type of ["private", "group", "supergroup", "channel"]) {
  for (const [label, run] of [
    ["verify", (ctx) => commands.verify(ctx)],
    ["document", (ctx) => handlers["message:document"](ctx)],
  ]) {
    record.fetches = []; record.fileFetches = 0; record.getFileCalls = 0; record.replies = [];
    await run({
      chat: { type, id: 123 },
      from: { id: 456 },
      message: { document: { file_size: 1000 } },
      getFile: async () => (record.getFileCalls++, { file_path: "fixture.json" }),
      api: { createChatInviteLink: async () => ({ invite_link: "https://t.me/+example" }) },
      reply: async (text) => record.replies.push(text),
      replyWithDocument: async (file, opts) => record.replies.push({ document: file.name, caption: opts?.caption }),
    });
    out[`${label}:${type}`] = structuredClone(record);
  }
}
// A gateway that refuses the adapter itself (a mismatched adapter secret) answers 401 with no reason code.
verifyResponse = { ok: false, status: 401, body: { error: "unauthorized" } };
record.fetches = []; record.fileFetches = 0; record.getFileCalls = 0; record.replies = [];
await handlers["message:document"]({
  chat: { type: "private", id: 123 },
  from: { id: 456 },
  message: { document: { file_size: 1000 } },
  getFile: async () => (record.getFileCalls++, { file_path: "fixture.json" }),
  reply: async (text) => record.replies.push(text),
});
out["document:private:401"] = structuredClone(record);
process.stdout.write(JSON.stringify(out));
