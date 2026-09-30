# Linux pilot walkthrough

This walkthrough is for a tester who runs a complete testnet pilot on their own infrastructure, joins
it as a member from a separate Linux computer, and records the acceptance checks. It uses a disposable
test community on Discord. Nothing here needs another operator's gateway, bot, or server.

The operator side is in [the moderator guide](MODERATOR_GUIDE.md), the member side is summarized in
[the member guide](MEMBER_GUIDE.md), and [the setup privacy explanation](SETUP_PRIVACY.md) covers what
the interim keys do and do not protect. This is a testnet pilot on interim single-contributor keys, so
do not gate anything of value on it.

## Part A. Stand up the pilot

Follow the moderator guide on a Linux host with a synced testnet Dash node. Use one durable gateway, the
two-tier mode, and a disposable Discord server or a private test channel. For the acceptance checks in
Part C, a short schedule makes the boundaries observable within a day, for example
`MNO_EPOCH_SECONDS=1800` and `MNO_SEASON_SECONDS=86400`. Choose it before the first registration,
because changing it later renumbers every period and the gateway then refuses its own stored state.

Before members can reach the gateway, confirm these on the deployed host rather than from its
configuration files:

- Adapter authentication is on, and its secret appears in no member command or log.
- Oracle signatures are required and the oracle's public key is pinned in `MNO_ORACLE_PUBKEYS`.
- `MNO_REGISTER_CONTEXTS` names exactly the pilot's context, and the testnet list is fresh.
- Nullifiers, registrations, clock marks, and bot grants are on durable local storage.
- The raw gateway port is reachable only through the intended front end. The gateway process listens
  on every interface it has, so a container published only to the host's loopback address, behind the
  front end, is what keeps it there.
- The public route exposes only the member endpoints (`/v1/health`, `/v1/dml`, `/v1/members`,
  `/v1/register`). The Dash node's RPC port, wallets, bot tokens, and any administrative interface stay
  off it.
- The bot's `MNO_MEMBER_GATEWAY_URL` is the public https address, and a `/verify` reply shows it in its
  commands rather than `<gateway-url>`.

A front end that ends TLS before the gateway, such as a content delivery network or a hosted tunnel,
can read everything a member's prover sends and could change what it receives. The proofs reveal no key
and no masternode, but that provider sees members' source addresses and timing, as the gateway operator
does. Members who pass `--node-list` do not depend on the list it returns (Part B, step 5).

## Part B. Join as a member from Linux

### 1. Check the machine

Use a computer other than the masternode server, because connecting from the masternode's advertised
address can identify it even though the proof does not. Open a Bash terminal and keep it for these steps.

```bash
node --version
npm --version
git --version
curl --version
uname -m
free -h
df -h .
```

Use Node.js 22.13 or newer. Allow about 4 GiB of memory headroom. The key downloads are about 175 MB,
and the package installation uses more disk than that.

### 2. Get the same software the gateway runs

Use the commit the pilot's gateway runs, with its matching key manifest. A different commit can carry
different keys, and its proofs would be refused.

```bash
git clone https://github.com/hilawe/dash-mno-verify.git dash-mno-pilot
cd dash-mno-pilot
read -r -p 'Commit the gateway runs: ' PILOT_COMMIT
git checkout --detach "$PILOT_COMMIT"
npm ci --omit=optional
bash scripts/fetch_keys.sh --large registration
```

The last command fetches the shared files too and verifies every download against the manifest. Do not
continue if any checksum fails.

### 3. Enter the pilot's public values

These are public configuration, not secrets. Keep the quotation marks in later commands.

```bash
read -r -p 'Pilot gateway address: ' PILOT_GATEWAY
read -r -p 'Discord server ID: ' PILOT_GUILD
read -r -p 'Proof context label: ' PILOT_CONTEXT
export PILOT_GATEWAY PILOT_GUILD PILOT_CONTEXT
curl --fail --show-error --silent "${PILOT_GATEWAY%/}/v1/health"
printf '\n'
```

The health response should report `ok: true`. That alone does not show the oracle is fresh or that the
context is enabled. Do not disable certificate checks or use an insecure transport override.

### 4. Save the testnet voting private key

You need the voting private key, not the collateral key, the operator key, a wallet seed, or an address.
This creates a private folder outside the checkout, refuses to overwrite an existing file, and reads the
key without showing it.

```bash
mkdir -p "$HOME/.local/share/dash-mno-pilot"
chmod 700 "$HOME/.local/share/dash-mno-pilot"
PILOT_KEY_FILE="$HOME/.local/share/dash-mno-pilot/testnet-voting-key.txt"
export PILOT_KEY_FILE
(
  umask 077
  set -o noclobber
  read -r -s -p 'Paste the TESTNET voting private key, then press Enter: ' PILOT_KEY
  printf '\n'
  test -n "$PILOT_KEY" || exit 1
  printf '%s\n' "$PILOT_KEY" > "$PILOT_KEY_FILE"
  unset PILOT_KEY
)
stat -c '%a %n' "$PILOT_KEY_FILE"
```

Expect permission `600`. To export the key from Dash Core instead, `dash-cli -testnet protx info
YOUR_PROTX_HASH` shows the voting address and `dash-cli -testnet dumpprivkey YOUR_VOTING_ADDRESS`
exports its key if that wallet holds it. An encrypted, hardware, or watch-only wallet may need a
different export. Running a masternode does not mean its server holds the voting key.

### 5. Export your own node's masternode list

Registration can build the masternode list itself from your node instead of trusting the gateway's
copy. Without it, whoever runs or fronts the gateway could serve a doctored list and narrow down which
masternode is yours from whether you go on to register. On a machine with a synced testnet node:

```bash
dash-cli -testnet masternodelist json > mnlist.json
```

Copy `mnlist.json` into `dash-mno-pilot`. With no node of your own, leave out `--node-list mnlist.json`
below and accept that the list is the gateway's.

### 6. Register before taking the challenge you will use

```bash
npm run register -- \
  --gateway "${PILOT_GATEWAY%/}" \
  --platform discord \
  --community "$PILOT_GUILD" \
  --role "$PILOT_CONTEXT" \
  --voting-key-file "$PILOT_KEY_FILE" \
  --node-list mnlist.json
```

Success prints `registered at members-tree index` and names a saved secret file. Keep that
`member.discord...secret.json` file private for the season. A retry must reuse it, so do not delete a
pending secret after a timeout. If the prover warns that your node's list differs from the gateway's
and registration is refused as `stale-or-unknown-root`, export the list again and re-run. Once
registered, `rm -- "$PILOT_KEY_FILE"` removes this copy of the key. Keep the member secret file.

### 7. Take a fresh challenge, prove, and submit

In the pilot's Discord server, type `/verify` from the account that should gain access. The reply is
visible only to you. Save `challenge.json` into `dash-mno-pilot` under exactly that name, even if an
earlier `/verify` was only to read the instructions.

```bash
npm run prove-epoch -- \
  --gateway "${PILOT_GATEWAY%/}" \
  --challenge challenge.json
```

Expect `Wrote proof.json`. Type `/submit`, attach `proof.json` in the command's attachment field, and
send it. The reply names the private channel and the time access ends. Open the channel to confirm.

## Part C. Acceptance checks

Record each result with the time, the reply text or reason code, and what the channel list showed.
Keep live platform results apart from the local and continuous-integration tests, which already pass.

1. **Admission.** A fresh ordinary account, not a server administrator, sees the private channel after
   `/submit`. An administrator sees every channel anyway, so it cannot show this.
2. **Wrong account refused.** Take a challenge with account A and submit its proof from account B. The
   reply is `account-mismatch` and B gains nothing.
3. **Expired challenge recovered.** Let a challenge pass its deadline, then submit its proof. The reply
   is `unknown-or-expired-challenge`. A fresh `/verify`, a new proof, and a submit then admit the
   member without registering again.
4. **Same-account retry.** Submit a second fresh proof from the admitted account in the same period. It
   is accepted, and access still ends at the same time.
5. **Restart recovery.** Restart the gateway and the bot without touching their stored state. The
   member keeps access, the gateway still lists the registration, and a new proof still verifies.
6. **Revocation.** After the access end passes, the bot removes the member's channel access at its next
   sweep and sends the access-ended message. Stopping the gateway does not revoke access, so revocation
   is checked with both running.

Do not reset stored state to make a check pass, and do not change the schedule of a running pilot.

## Part D. Contribute to the setup ceremony

This is separate from membership testing and needs no voting key. Use [the Linux contributor
guide](ceremony/CONTRIBUTOR_GUIDE.md) with the exact ceremony announcement, and wait for its announced
source reference, incoming artifact hashes, and beacon policy. The membership checkout above is not the
frozen ceremony checkout.

Each contributor works on their own machine, once for each of the two heavy circuits:

1. Verify the incoming public file.
2. Contribute independent randomness, and keep no copy of it.
3. Publish the contribution hash and send back the public output file.

Check afterwards that every contribution hash appears in the final published transcripts. The interim setup stays labeled as a single-contributor setup until those contributions
are recorded and the ceremony's keys replace it.
