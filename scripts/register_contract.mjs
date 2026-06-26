// Register the dash-mno-verify data contract on Dash Platform, once, under a funded
// identity. It prints the contract id to use as MNO_PLATFORM_CONTRACT_ID. Needs the optional
// `dash` SDK and a wallet that already holds a funded Platform identity. See docs/PLATFORM.md
// for creating and funding one.
//
// Usage:
//   MNO_PLATFORM_NETWORK=testnet MNO_PLATFORM_MNEMONIC="twelve words ..." \
//     node scripts/register_contract.mjs
import { readFile } from "node:fs/promises";
import process from "node:process";

const network = process.env.MNO_PLATFORM_NETWORK ?? "testnet";
const mnemonic = process.env.MNO_PLATFORM_MNEMONIC;
if (!mnemonic) {
  console.error("Set MNO_PLATFORM_MNEMONIC to a wallet with a funded Platform identity.");
  process.exit(1);
}

let Dash;
try {
  Dash = (await import("dash")).default;
} catch {
  console.error("This needs the optional 'dash' dependency: npm install dash");
  process.exit(1);
}

const client = new Dash.Client({ network, wallet: { mnemonic } });
try {
  const account = await client.getWalletAccount();
  const identityId = account.identities.getIdentityIds()[0];
  if (!identityId) {
    console.error("No Platform identity in this wallet. Create and fund one first (see docs/PLATFORM.md).");
    process.exit(1);
  }
  const identity = await client.platform.identities.get(identityId);

  const documents = JSON.parse(await readFile("contract/mno-verify.contract.json", "utf8"));
  const contract = await client.platform.contracts.create(documents, identity);
  await client.platform.contracts.publish(contract, identity);

  const id = contract.getId().toString();
  console.log("contract registered. id:", id);
  console.log("Now run the gateway with:");
  console.log(`  MNO_STORE=platform MNO_PLATFORM_NETWORK=${network} MNO_PLATFORM_CONTRACT_ID=${id} MNO_PLATFORM_MNEMONIC=... npm run gateway`);
} finally {
  client.disconnect();
}
