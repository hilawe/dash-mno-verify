// Generate an Ed25519 oracle signing key. Prints the private key as PKCS8 PEM, to save for the oracle
// (MNO_ORACLE_SIGNING_KEY, a file path or inline), and the raw public key as base64, for the gateway
// to pin (MNO_ORACLE_PUBKEYS). Run once per independent oracle; pin every public key and set
// MNO_ORACLE_QUORUM to how many must sign.
import { generateKeyPairSync } from "node:crypto";
import { rawPublicB64 } from "../common/oracle_sig.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).trimEnd();
const pub = rawPublicB64(publicKey);

console.log("# Ed25519 oracle signing key. Keep the private key secret.");
console.log("#");
console.log("# Oracle: save this private key, then point MNO_ORACLE_SIGNING_KEY at the file (or pass it inline).");
console.log(pem);
console.log("#");
console.log("# Gateway: pin this public key. Comma-separate several keys for a quorum, and set MNO_ORACLE_QUORUM.");
console.log(`MNO_ORACLE_PUBKEYS=${pub}`);
