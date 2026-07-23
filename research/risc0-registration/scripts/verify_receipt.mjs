// Node-side receipt verification for the gated receipt-path decision (work-plan step 3 of
// docs/ZKVM_INTEGRATION.md). This is the gateway's real path, not a Rust timing: it builds
// the exact request body a member would POST, DECODES it back the way the gateway would,
// writes the decoded receipt to a temp file, and invokes the pinned verifier on those
// decoded bytes (not on the original file). The verifier binds the guest image identifier to
// the journal and rejects a tampered receipt and a wrong image id. It reports request wire
// size and single-request latency, the inputs the wrapped-versus-unwrapped decision needs.
//
// This is a research harness. It shells out to the pinned `host verify` for the unwrapped
// path; a pure-JS Groth16 verifier for the wrapped path is exactly the step-3 alternative to
// be decided, so the harness measures the real verifier rather than prejudging one.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const mode = process.argv[2]; // "wrapped" | "unwrapped"
const imageId = process.argv[3]; // hex REGISTRATION_REG_ID the host printed
if (!mode || !imageId) {
  console.error("usage: node verify_receipt.mjs <wrapped|unwrapped> <imageId-hex>");
  process.exit(2);
}

// The proposed registration request body: base64 receipt plus the claimed image id and engine.
// The gateway never trusts the journal in the body; it takes the journal FROM the verified
// receipt. Measuring the encoded body answers the 2 MB-limit question.
function buildRequestBody(receiptPath) {
  const receipt = readFileSync(receiptPath);
  return JSON.stringify({ engine: "zkvm", imageId, receipt: receipt.toString("base64") });
}

// Decode a request body the way the gateway would: validate engine and image id, then decode
// the receipt bytes from base64 and hand exactly those to the verifier.
function decodeRequest(body) {
  const req = JSON.parse(body);
  if (req.engine !== "zkvm") throw new Error(`unexpected engine ${req.engine}`);
  if (req.imageId !== imageId) throw new Error("request image id does not match the pinned id");
  return Buffer.from(req.receipt, "base64");
}

function verify(decodedReceipt, expectImageId) {
  const tmp = join(tmpdir(), `mno_receipt_${process.pid}.bin`);
  writeFileSync(tmp, decodedReceipt);
  const out = execFileSync("./target/release/host", ["verify", tmp, expectImageId], {
    encoding: "utf8",
  });
  const m = out.match(/journal_hex:\s*([0-9a-f]+)/);
  if (!m) throw new Error("verifier did not return a journal");
  return m[1];
}

function main() {
  const receiptPath = mode === "wrapped" ? "wrap_receipt.bin" : "receipt_reg.bin";
  const body = buildRequestBody(receiptPath);
  const bodyBytes = Buffer.byteLength(body);
  console.log(`[node] mode: ${mode}`);
  console.log(`[node] request_body_bytes: ${bodyBytes}`);
  console.log(`[node] within_2mb_limit: ${bodyBytes <= 2 * 1024 * 1024}`);

  // Decode the request exactly as the gateway would, then verify those decoded bytes.
  const decoded = decodeRequest(body);
  console.log(`[node] decoded_receipt_bytes: ${decoded.length}`);

  const t0 = process.hrtime.bigint();
  const journal = verify(decoded, imageId);
  const t1 = process.hrtime.bigint();
  console.log(`[node] verify_ms_single: ${Number(t1 - t0) / 1e6}`);
  console.log(`[node] journal_len_bytes: ${journal.length / 2}`);

  // Binding rejections: a wrong image id and a tampered receipt must both fail. The host's
  // verify already rejects a wrong image id (exit 1) and asserts tampered-journal rejection
  // internally; here we drive the wrong-image path from Node explicitly.
  let rejectedWrongId = false;
  try {
    verify(decoded, imageId.replace(/.$/, (c) => (c === "0" ? "1" : "0")));
  } catch {
    rejectedWrongId = true;
  }
  console.log(`[node] rejects_wrong_image_id: ${rejectedWrongId}`);

  // A corrupted request body (bad base64 / truncated receipt) must not verify.
  let rejectedCorruptBody = false;
  try {
    const corrupt = JSON.parse(body);
    corrupt.receipt = corrupt.receipt.slice(0, -8) + "AAAAAAAA";
    verify(Buffer.from(corrupt.receipt, "base64"), imageId);
  } catch {
    rejectedCorruptBody = true;
  }
  console.log(`[node] rejects_corrupt_receipt: ${rejectedCorruptBody}`);

  if (!rejectedWrongId || !rejectedCorruptBody) {
    console.error("[node] a binding rejection did not fire");
    process.exit(1);
  }
  console.log("[node] verification harness passed");
}

main();
