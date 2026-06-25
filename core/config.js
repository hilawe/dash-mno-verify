import process from "node:process";

// All deployment-specific values come from the environment so nothing is hard-coded.
export const config = {
  port: Number(process.env.MNO_GATEWAY_PORT ?? 8787),

  // How a membership epoch is sized. One week by default. A sold node loses access
  // within one epoch, because it can no longer produce a fresh proof.
  epochSeconds: Number(process.env.MNO_EPOCH_SECONDS ?? 7 * 24 * 3600),

  // How long an issued challenge stays valid before the member must request a new one.
  challengeTtlSeconds: Number(process.env.MNO_CHALLENGE_TTL ?? 600),

  // How many recently published roots the gateway will accept. A small window absorbs
  // DML churn between blocks while keeping the eviction lag for removed nodes short.
  rootWindow: Number(process.env.MNO_ROOT_WINDOW ?? 8),

  // Where to read freshly published roots from. Either a URL serving the oracle JSON
  // or a local file path.
  oracleSource: process.env.MNO_ORACLE_SOURCE ?? "oracle/root.json",
  oracleRefreshSeconds: Number(process.env.MNO_ORACLE_REFRESH ?? 30),

  // Groth16 verification key produced from the compiled circuit's setup.
  verificationKeyPath: process.env.MNO_VKEY ?? "circuits/build/verification_key.json",
};
