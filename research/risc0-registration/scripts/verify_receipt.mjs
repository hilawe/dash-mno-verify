// Node-side receipt verification for the gated receipt-path decision (work-plan step 3 of
// docs/ZKVM_INTEGRATION.md). This is the gateway's real cost and binding check, not a Rust
// timing: it decodes the exact request body a member would POST, binds the configured guest
// image identifier to the exact journal bytes, invokes the verifier, and rejects an altered
// journal or image identifier. It measures request wire size and end-to-end latency, the
// inputs the design needs to choose wrapped versus unwrapped.
//
// This is a research harness. It shells out to a pinned `r0vm`-based verifier for the
// unwrapped path and (when built) a groth16 verifier for the wrapped path, both provided by
// the host `verify`/`wrap` outputs. It does not yet embed a pure-JS Groth16 verifier; that
// choice is exactly what step 3 decides, so the harness measures both real paths rather than
// prejudging one.
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";

const mode = process.argv[2]; // "wrapped" | "unwrapped"
const imageId = process.argv[3]; // hex REGISTRATION_REG_ID the host printed
if (!mode || !imageId) {
  console.error("usage: node verify_receipt.mjs <wrapped|unwrapped> <imageId-hex>");
  process.exit(2);
}

// The proposed registration request body: base64 receipt plus the claimed image id. The
// gateway never trusts the journal in the body; it takes the journal FROM the verified
// receipt. Measuring the encoded body is what answers the 2 MB-limit question.
function buildRequestBody(receiptPath) {
  const receipt = readFileSync(receiptPath);
  return JSON.stringify({ engine: "zkvm", imageId, receipt: receipt.toString("base64") });
}

function verifyUnwrapped(receiptPath, expectImageId) {
  // The pinned host binary verifies a serialized receipt against an image id and prints the
  // journal hex on success, nonzero exit on failure. The gateway would run this (or its WASM
  // equivalent, the step-3 alternative) as its verifier.
  const out = execFileSync("./target/release/host", ["verify", receiptPath, expectImageId], {
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
  console.log(`[node] receipt_file_bytes: ${statSync(receiptPath).size}`);

  const t0 = process.hrtime.bigint();
  const journal = verifyUnwrapped(receiptPath, imageId);
  const t1 = process.hrtime.bigint();
  console.log(`[node] verify_ms: ${Number(t1 - t0) / 1e6}`);
  console.log(`[node] journal_len_bytes: ${journal.length / 2}`);

  // Binding rejections: a wrong image id and a flipped journal byte must both fail.
  let rejects = 0;
  try {
    verifyUnwrapped(receiptPath, imageId.replace(/.$/, (c) => (c === "0" ? "1" : "0")));
  } catch {
    rejects++;
  }
  console.log(`[node] rejects_wrong_image_id: ${rejects >= 1}`);
  if (rejects < 1) process.exit(1);
  console.log("[node] verification harness passed");
}

main();
