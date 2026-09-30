# Moderator setup and operating guide

This is the current practical entry point for a private-community pilot, reviewed against `00f292c`
on September 29, 2026. A moderator handles accounts and channel settings. A service operator handles
the gateway, oracle, secrets, network exposure, and backups. These may be the same person, but routine
moderation should not require touching wallets or circuit tools.

**Start with one gateway, one oracle source, and one platform.** Discord has the most complete member
messages. Telegram needs a private-chat guard before a privacy-sensitive launch. Matrix requires
careful direct-room settings. The web adapter is a reference implementation rather than a complete
production account system. The [review findings](reviews/REVIEW_FINDINGS_dash-mno-verify_2026-09-29.md)
record the outstanding limits.

The released heavy keys are interim single-contributor keys. The planned independent ceremony is
separate. [SETUP_PRIVACY.md](SETUP_PRIVACY.md) explains the difference between proof privacy, forged
membership, and private-chat access.

## What members should experience

1. Follow the member setup guide once, on their own computer.
2. Register with their voting key once per season. The key stays local.
3. Request a fresh platform challenge, generate a membership proof, and submit only `proof.json`.
4. Receive access until the displayed boundary. Repeat in the next season.

In two-tier mode the default season and access period are both ninety days, measured from fixed
shared boundaries. Joining near a boundary gives less than ninety days. Members can use the same
registration to recover access on the same account during the period. They cannot move that membership
to another account until the next period. Lost member secrets can strand membership for the season.

## Choose a platform and record its context

Every registration belongs to one exact platform, community, and context label. The gateway allowlist
must contain the hash of that tuple. The member command and adapter must use the same tuple.

| Platform | Community value | Context label | Required platform permissions | Current limitation |
| --- | --- | --- | --- | --- |
| Discord | `DISCORD_GUILD_ID` | `DISCORD_CONTEXT_ID`, set it explicitly (for example `mn-members`), since it defaults to the first grant channel ID | Bot can view the target and manage its permission overwrites | No supported per-member exclusion while the bot keeps granting |
| Telegram | `TELEGRAM_COMMUNITY`, default group identifier | `TELEGRAM_ROLE`, default `member` | Invite users and restrict members | Verification works only in private chats with the bot |
| Matrix | `MATRIX_COMMUNITY`, default gated room identifier | `MATRIX_ROLE`, default `member` | Invite and kick users | Direct verification room must meet privacy checks and bot does not decrypt encrypted messages |
| Web | `MNO_WEB_COMMUNITY` | `MNO_WEB_ROLE`, default `members` | Service operator controls the site | In-memory sessions and incomplete production hardening |

Keep these values stable. Changing a context or a schedule is a migration, not a cosmetic rename.
Using a different gateway for each platform is unnecessary for a small pilot, but each allowed tuple
must be listed and each adapter needs its own durable grant ledger.

## Set up one Discord pilot

### 1. Prepare the community

Create a private test channel. Deny `View Channel` to `@everyone`. Remove unrelated roles that grant
ordinary members access to that channel. Administrator accounts can bypass channel restrictions and
must not be used as proof that the gate works. Create a separate visible channel where a new member
can run `/verify` before admission.

Create a bot in the Discord developer portal, invite it with `bot` and `applications.commands`, and
configure the permissions described in the Discord adapter README. The bot needs no privileged intent. Keep the bot
out of unrelated sensitive channels. Do not grant Administrator merely to avoid diagnosing missing
permissions.

The bot reconciles member permission overwrites on managed channels. Use a disposable test channel
first. Existing manually granted access may be removed during reconciliation. Review who should be
admitted before adding an existing private channel to the managed list.

### 2. Prepare the operator machine

Install a supported Node.js release at least 22.13, Git, and access to a synced Dash node on the chosen
network. Testnet and mainnet must not be mixed. The oracle reads the network selected by the Dash
connection. The prover does not turn a mainnet snapshot into testnet merely because its key is testnet.

```bash
git clone https://github.com/hilawe/dash-mno-verify.git
cd dash-mno-verify
npm ci
mkdir -p data/operator
chmod 700 data/operator
```

Record and deploy the same reviewed revision for the gateway and bot. Moderators do not need the large
proving keys. Verification keys are committed. Members fetch their own proving artifacts.

### 3. Prepare the oracle and private configuration

Arrange the member endpoint with the host operator first. For a Quick Tunnel, the operator can start
the tunnel against the intended local upstream before the gateway is ready and obtain its random
address. Requests will fail until the gateway starts. Do not invite testers yet. Section 5 describes
the exposure controls. A stable-domain deployment can reserve its address in advance.


Generate a signing key once. The following refuses to overwrite an existing file.

```bash
(umask 077; set -o noclobber; node scripts/gen_oracle_key.mjs > data/operator/oracle-key.txt)
```

This file contains both the private signing key and a public-key line. Keep it private. It is separate
from every masternode voting or collateral key.

Enter the bot values in Bash. The token prompt does not echo. Never send the token to members.

```bash
read -r -s -p 'Discord bot token: ' DISCORD_TOKEN; printf '\n'
read -r -p 'Discord application ID: ' DISCORD_APP_ID
read -r -p 'Discord server ID: ' DISCORD_GUILD_ID
read -r -p 'Private channel ID: ' DISCORD_GRANT_CHANNEL_IDS
read -r -p 'Reachable member gateway address: ' MNO_MEMBER_GATEWAY_URL
export DISCORD_TOKEN DISCORD_APP_ID DISCORD_GUILD_ID DISCORD_GRANT_CHANNEL_IDS MNO_MEMBER_GATEWAY_URL
```

Create the configuration once, including the registration context that older examples omitted. This
writes a private file and prints no credentials.

```bash
node --input-type=module <<'NODE'
import {readFileSync, writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {contextHash} from './common/index.js';
const e = process.env;
for (const name of ['DISCORD_TOKEN','DISCORD_APP_ID','DISCORD_GUILD_ID','DISCORD_GRANT_CHANNEL_IDS','MNO_MEMBER_GATEWAY_URL']) {
  if (!e[name] || /[\r\n]/.test(e[name])) throw Error(`Set a one-line ${name} first`);
}
const u = new URL(e.MNO_MEMBER_GATEWAY_URL);
if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
  throw Error('Use a plain secure gateway origin with no path, credentials, query, or fragment');
}
const pub = readFileSync('data/operator/oracle-key.txt','utf8').match(/^MNO_ORACLE_PUBKEYS=(.+)$/m)?.[1];
if (!pub) throw Error('Oracle public key line missing');
const role = 'mn-members';
const config = {
  MNO_MODE: 'two-tier', MNO_STORE: 'sqlite',
  MNO_ADAPTER_SECRET: randomBytes(32).toString('hex'),
  MNO_ORACLE_SIGNING_KEY: 'data/operator/oracle-key.txt', MNO_ORACLE_PUBKEYS: pub,
  MNO_REGISTER_CONTEXTS: contextHash({platform:'discord',communityId:e.DISCORD_GUILD_ID,roleId:role}).toString(),
  MNO_GATEWAY_URL: 'http://127.0.0.1:8787', MNO_MEMBER_GATEWAY_URL:u.origin,
  DISCORD_CONTEXT_ID: role,
  DISCORD_TOKEN:e.DISCORD_TOKEN, DISCORD_APP_ID:e.DISCORD_APP_ID,
  DISCORD_GUILD_ID:e.DISCORD_GUILD_ID, DISCORD_GRANT_CHANNEL_IDS:e.DISCORD_GRANT_CHANNEL_IDS
};
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
writeFileSync('data/operator/pilot.env', Object.entries(config).map(([k,v])=>`${k}=${quote(v)}`).join('\n')+'\n', {mode:0o600,flag:'wx'});
console.log('Created data/operator/pilot.env with private permissions');
NODE
```

Use simple numeric Discord identifiers and the origin supplied by the operator. Store only trusted
configuration in this file. In each terminal that runs a service, load it from the checkout directory.

```bash
set -a
source data/operator/pilot.env
set +a
```

Do not put this file in a repository commit or share it with members. Do not regenerate it on restart,
since doing so would change the adapter secret. Gateway and bot must read the same secret.

### 4. Run the oracle, gateway, and bot

The oracle alone needs Dash access. Configure `MNO_RPC_URL`, `MNO_RPC_USER`, and `MNO_RPC_PASS` in the
private configuration if using a remote procedure call (RPC) connection, or provide a `dash-cli` on the
operator's executable search path. For testnet, ensure that connection selects testnet. Keep Dash RPC
on a private interface. Never expose it through the member tunnel.

In one terminal with the configuration loaded, publish and refresh the signed snapshot.

```bash
while true; do npm run oracle; sleep 120; done
```

Confirm an initial successful snapshot before continuing. In a second configured terminal, start the
gateway with `npm run gateway`. In a third configured terminal, start the bot with `npm run bot`.
Each should remain running. The bot must finish reconciliation before members try `/verify`.

The raw gateway currently listens on all available interfaces. A loopback value in
`MNO_GATEWAY_URL` controls how the bot connects, not where the server binds. Keep port 8787 blocked
from public ingress through the host firewall or a loopback-only container port mapping. The remote
exposure decision must account for this before starting the service on an internet-facing host.

For unattended use, move these three processes to the operator's existing service manager with the
checkout as working directory, the same private environment, restart on failure, and logs available
to the operator. Do not launch a second bot against the same ledger. A service manager restarts a
process but does not prove that permissions, snapshots, or revocation are healthy.

### 5. Expose only the member service needed for the pilot

Keep `MNO_GATEWAY_URL` private for adapter requests. Set `MNO_MEMBER_GATEWAY_URL` to the public
secure address members can reach. They are different addresses for different callers.

A Cloudflare Quick Tunnel is an acceptable short testnet option if the host owner approves the
exposure and participants understand the provider's visibility. It creates an outbound connection and
requires no new inbound listening port. It still makes the selected service publicly reachable. It
is not an anonymity system, has no uptime guarantee, and its random address changes across restarts.
[Cloudflare's Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

The required member routes are `GET /v1/health`, `GET /v1/dml`, `GET /v1/members`, and
`POST /v1/register`. Registration reads the season from the health route, so it must be reachable.
Prefer a small reverse-proxy allowlist in front of the tunnel that
blocks `/v1/challenge` and `/v1/verify` publicly. The bot reaches those locally with the adapter secret.
The gateway's own authentication remains necessary even with that allowlist.

- Preserve signed-oracle verification, adapter authentication, durable storage, and registration context
  restrictions. Local development overrides must not become public pilot settings.
- Use a pinned tunnel image or binary. If containerized, confirm it can reach the intended service.
  A container's `127.0.0.1` is not automatically the host's loopback interface.
- Configure proxy rate-limit addresses only after establishing the trusted header chain.
  `MNO_TRUST_PROXY=1` trusts the last forwarded address. Do not enable it blindly or expose a direct
  origin path through which an attacker can supply that header.
- Stop the tunnel with the pilot's off switch. Update the bot's member address if the tunnel restarts.

A domain and reverse proxy provide a stable longer-term address. An onion service may offer a better
network privacy model, but the current prover needs separately configured and tested routing. Neither
is required to finish the first clearly labeled testnet pilot.

### 6. Check the real member journey

Use an ordinary Discord account that is not an administrator and has no independent channel allow.
From another network, check that the public health route works. Confirm the configured context and a
fresh oracle snapshot through a real registration, not merely `ok: true` on health.

Request `/verify` and inspect its actual address, private visibility, and local-time deadline. Register
first, request a fresh challenge, then prove and submit. Confirm that the named private channel appears.
Repeat the proof with the same account to test recovery. A different account must not reuse the same
membership during the period.

Use a separate disposable community and separate state paths for accelerated expiry tests. Show that
access disappears after expiry and the next successful sweep. Restart the bot and confirm that a
persisted grant is still tracked. Do not change the pilot's schedule or erase its ledger to make a
ninety-day boundary arrive sooner.

## Telegram moderator checklist

Use a new private test group and invite the bot as an administrator with invite and restrict rights.
Only the bot's join-request links should admit ordinary members. Remove public join links and avoid
manual additions that bypass the ledger. Existing members must be reconciled deliberately.

Set the following in the adapter environment, along with `MNO_ADAPTER_SECRET`, `MNO_GATEWAY_URL`,
and `MNO_MEMBER_GATEWAY_URL` from the shared configuration.

```bash
export TELEGRAM_BOT_TOKEN='REPLACE_WITH_BOT_TOKEN'
export TELEGRAM_GROUP_ID='REPLACE_WITH_GROUP_ID'
export TELEGRAM_ROLE='member'
```

Add this tuple's derived context to the gateway's comma-separated `MNO_REGISTER_CONTEXTS`, preserving
any Discord contexts already there. Restart the gateway after editing its allowlist.

```bash
node --input-type=module -e 'import {contextHash} from "./common/index.js"; console.log(contextHash({platform:"telegram",communityId:process.env.TELEGRAM_COMMUNITY ?? process.env.TELEGRAM_GROUP_ID,roleId:process.env.TELEGRAM_ROLE ?? "member"}).toString())'
```

On first launch, the adapter may refuse until reconciliation is recorded. For a newly created group,
confirm no ordinary users already have access. Then run the specific target-scoped acknowledgment
printed by the bot. Do not acknowledge an existing group without reviewing its membership.

**Current code requires a repair before a privacy-sensitive Telegram pilot.** Both `/verify` and proof
uploads must reject non-private chats before fetching a challenge or file. Until that is implemented,
asking members to use direct messages is guidance, not an enforced privacy boundary.

Once repaired, the member sends `/verify` privately to the bot, submits `proof.json` as a document in
that same private chat, follows the returned link, and requests to join. There is no Telegram `/submit`
command. A second account following the link must be declined. Confirm expiry removal and successful
rejoining after a new valid proof. Do not test removal using the group owner or an administrator.

## Matrix and web

Matrix members use `!verify` in an invite-only one-to-one room with exactly the bot and member joined
and history visibility set to `joined`. The bot handles plain text events and does not implement
end-to-end decryption, so an encrypted direct room is not a supported path. Room privacy settings do
not hide messages from participating homeservers. A valid proof causes an invitation to the gated room.
The member must accept it. Give the bot kick permission and test expiry in a disposable room.

Set `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_USER_ID`, and `MATRIX_GATED_ROOM`, then derive
the context from platform `matrix`, that room identifier, and role `member`, unless the adapter overrides
those defaults. Preserve the context in the gateway allowlist. Use a separate ledger from Discord or
Telegram.

The web adapter's `/members` page is the example protected resource. It does not secure arbitrary
pages in another application. Sessions are in memory and disappear on restart. Plan secure transport,
cookie hardening, session lifecycle, and a real application authorization integration before treating it
as a production gate. A random opaque session identifier does not become forgeable merely because it
is unsigned, but its transport and ownership still matter.

## Routine operations and recovery

| Symptom | Moderator action | Operator action |
| --- | --- | --- |
| `<gateway-url>` in instructions | Stop onboarding and request the real address | Set the member address and restart the adapter |
| Challenge expired | Request a fresh challenge and regenerate proof | Check clock and processing latency if repeated |
| Service unavailable | Do not ask for a voting key | Check service logs, oracle freshness, and context allowlist |
| Already used by another account | Use the first account for the current period | Explain account binding without clearing spend records |
| Lost member secret | Restore the member's own backup | Do not promise recovery or reset shared spend state |
| Access survives expiry | Treat removal as delayed until confirmed | Inspect sweep failures and platform permissions |
| Clock-regressed refusal | Report it | Correct the clock before any explicit recovery operation |
| Gateway refuses changed schedule | Keep members informed | Restore the old explicit schedule or perform a planned migration |

Back up registration records, nullifier storage, adapter ledgers, clock markers, and protected service
configuration together. Use a consistent database backup or stop the relevant services before copying
live database files. Store backups encrypted and restrict access. Do not erase a ledger to make startup
succeed. Restore into a controlled environment and test both a surviving grant and an expired grant.

Stopping the bot does not remove existing channel access. To retire Discord targets, stop the bot
first so the decommission command can acquire the same exclusive ledger. Keep its configuration and
platform permissions available. Preview the exact target, inspect the listed removals, then apply.
Replace the example identifier before running either command.

```bash
npm run discord:decommission -- channel:CHANNEL_ID
# After confirming that the preview names only the intended target:
npm run discord:decommission -- channel:CHANNEL_ID --apply
```

The first command changes nothing. Confirm successful removal before changing the managed channel
list or restarting the bot. Never drop a channel from configuration and assume access disappeared.

Before expanding beyond the pilot, finish the private-chat guard and accepted moderation policy, prove
a complete member journey and expiry on each platform actually used, and agree on who operates the
service. Keep the other adapters outside the acceptance claim until their own live checks pass.
