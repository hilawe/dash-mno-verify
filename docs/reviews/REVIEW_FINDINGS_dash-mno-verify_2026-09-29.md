# Project review and moderator readiness

Reviewed September 29, 2026 against source revision
`00f292c26494bfcd123dfa6dfabf386e3a43b3a3`. Documentation changes described here are uncommitted.
Runtime code, circuits, manifests, release artifacts, Git state, and remote services were not changed.

## Assessment

The proving-cost problem has improved substantially. The released registration proving key is
121,755,411 bytes, compared with the earlier 2,283,307,972-byte artifact. That is about an 18.75-fold
reduction in this file's size, not an equivalent claim about every machine's proving time. A fresh
registration-only download fetched and verified all five required release artifacts, totaling
175,530,598 bytes. A moderator running only the verifier does not need the large proving key.

A complete local two-tier flow passed using those released artifacts, a signed synthetic list, an
authenticated adapter, and the default 900-second registration-root limit. Registration took 16.72
seconds and the subsequent membership proof took 8.283 seconds on an Apple M1 Pro with 16 GiB of
memory and Node.js 26.0.0. These are one-run local measurements with one synthetic leaf. They are not
Linux measurements, live masternode evidence, network latency estimates, or peak-memory measurements.

The remaining obstacles to a useful pilot are predominantly operational and user-facing. Telegram
has an enforceable privacy boundary missing from its handlers. Some messages overstate privacy or
give incorrect renewal guidance. Existing setup documents contradicted the current configuration.
The Discord pilot is the sensible first acceptance target, with the stated exclusion limitation and
interim setup trust made explicit. This review does not certify production readiness or establish a
new cryptographic soundness result.

- Repair the Telegram private-chat boundary before a privacy-sensitive Telegram launch.
- Use the new moderator and Linux guides for the next Discord test.
- Verify the actual host configuration before making its member endpoints public.
- Keep the two-person setup ceremony separate from membership testing and from the interim release.

## Findings requiring runtime or operational follow-up

### F1. Telegram verification is processed in group chats

**Priority 1. Open runtime defect.** Both `bot.command("verify")` at
`adapters/telegram/bot.js:103` and `bot.on("message:document")` at line 148 lack a private-chat guard.
The command sends its challenge and instructions to the invoking chat. Proof submission can send the
verification result and invitation to that same chat.

The actual handlers were executed with simulated private and supergroup contexts. Both contexts
requested a challenge. Both proof-upload contexts called the gateway and emitted the successful
verification and join link when given a simulated successful gateway response. External services,
file download, and ledger operations were substituted. This reproduced handler routing, not a live
Telegram admission.

Account binding prevents another account from spending the proof or using the join-request link.
It does not prevent exposing that someone sought or completed masternode verification. The existing
"safe to send" challenge comment confuses the absence of a private key with the absence of private
activity. A guard cannot retract a file a member already posted to a group, but it can stop processing
and amplifying that disclosure.

Reject non-private chats at the start of both handlers, before a gateway request or attachment fetch.
Reply only with a short instruction to open the bot privately. Test private success and group refusal
through the real handler wiring, asserting zero gateway and file calls in the refused case. Also
check forwarded proofs, mismatched accounts, join requests from a second account, expiry, and rejoin
in the eventual live Telegram pilot.

### F2. Member messages promise more privacy than the application establishes

**Priority 2. Open runtime copy defect, documentation repaired.** Discord's
`adapters/discord/messages.js:55` says that which masternode is theirs never leaves the computer.
Telegram at `adapters/telegram/bot.js:142` and Matrix at `adapters/matrix/bot.js:84` make the same broad
claim. The web members page says the gate never learned an address.

The intended proof hides the selected list entry. A member who proves from the masternode's advertised
network address may identify it to the gateway or fronting service. Timing, an extremely small
eligible set, and platform activity remain visible. Control of a voting key also demonstrates owner
or voting-delegate authority, not necessarily operation or ownership of a particular machine.

Use a short accurate first sentence, such as "Prove control of an eligible masternode voting key
without including that key or the selected node in the proof's public inputs." Link the privacy guide
for network and community limits. Do not turn a short bot reply into a cryptography lecture.

The new [setup privacy explanation](../SETUP_PRIVACY.md), member guide, and threat-model changes
qualify these claims. Runtime strings were captured unchanged in
[the message previews](MEMBER_MESSAGE_PREVIEWS_2026-09-29.md), so readers can distinguish today's
messages from proposed wording.

### F3. Shell commands do not quote operator-provided arguments

**Priority 2. Open usability and configuration-safety defect.**
`common/prover_instructions.js:66-67` interpolates gateway, platform, community, and role directly into
shell commands. The URL guard checks transport but permits query strings and other characters with
shell meaning. Matrix room identifiers begin with `!`, which also has interactive shell implications.
Custom context labels are not constrained to a shell-safe alphabet here.

Use a tested shell-argument quoting helper for every inserted value. Independently require a clean,
usable gateway base address, because quoting a malformed base does not fix endpoint construction.
Reject credentials, fragments, and query strings unless an actual supported deployment requires them.
Test spaces, apostrophes, exclamation marks, and shell metacharacters without executing external
commands. This is not a demonstrated remotely exploitable injection through an untrusted member input.
It is a copy-and-paste boundary populated by operator configuration.

The new moderator guide accepts a plain secure origin and creates its private environment file with
shell quoting. Its configuration block was executed with a synthetic value containing quotes and
shell metacharacters, then sourced. The value survived unchanged and the file had mode 600.

### F4. Renewal and failure instructions can send members into unproductive retries

**Priority 2. Open runtime message defect.** The captured Telegram success says "re-verify before
then to keep it." Matrix says the same. With the default two-tier schedule, the access period equals
the season. Re-proving before the boundary grants only the same remaining period. It does not extend
membership into the next season. Members must register and prove after the new season begins.

Telegram and Matrix also promise "Your proof is still valid" on a network exception. The gateway may
have consumed its challenge before a response was lost. A transport error cannot establish proof
validity or the state of the server. Generic "start over" replies for every refusal also conceal
configuration failures that a member cannot fix.

Use the gateway's explicit expiry and schedule information. State that access ends at a fixed boundary
and explain the action after that boundary. For an uncertain response, permit a bounded retry and
then explain fresh-challenge recovery. Distinguish expired challenge, wrong account, membership already
used, service misconfiguration, and unavailable oracle. Keep a short reason code for moderators.
Never resolve an account conflict by clearing shared spend records.

### F5. First-time setup still competes with a running challenge

**Priority 2. Open user-flow limitation, guide workaround provided.** Discord issues the challenge
before displaying registration and setup instructions. Faster Groth16 proving makes the old
thirteen-minute registration mismatch less severe, but package installation, downloading artifacts,
exporting a key, and diagnosing setup can still exceed ten minutes. The Discord message does not
explicitly ask a first-time member to obtain a fresh challenge after registration.

The Linux guide now performs setup and registration first, then requests `/verify`. Keep that ordering
in the bot's first-time instructions. A future improvement can offer a setup action before issuing a
timed challenge. Do not lengthen a security-sensitive deadline merely to accommodate installation.

### F6. Public exposure requires checking the deployed environment

**Priority 1 deployment gate. Not a confirmed remote-host vulnerability.** This review did not inspect
or change the pilot host's current firewall, container mappings, or environment. A pasted status report
is not evidence that its development overrides are disabled or that it only listens on loopback.

`core/gateway.js:1679` calls `server.listen(port)` without a host address. The raw process listens on
available interfaces. Setting the bot's `MNO_GATEWAY_URL` to `127.0.0.1` does not change that binding.
A container mapped only to host loopback can provide the desired isolation, but that mapping must be
verified on the actual host.

Before connecting a public tunnel, confirm all of the following on the deployed configuration.

- Adapter authentication is enabled and its secret is absent from member commands and logs.
- Oracle signatures are required and the trusted public key is pinned.
- Registration contexts are allowlisted and the intended testnet list is fresh.
- Nullifiers, registrations, clock markers, and adapter grants use durable protected storage.
- Direct access to the raw gateway is blocked or mapped only to loopback.
- Public member routes are limited to health, list, members-tree, and registration endpoints where
  practical. The registration command requires `GET /v1/health` to learn the current season.
- Dash remote procedure call (RPC), wallets, bot tokens, and administrative endpoints are outside
  the public route and container mount scope.

A Cloudflare Quick Tunnel is reasonable for an explicitly labeled, temporary testnet experiment
with host-owner approval. It creates a public route even though its connection is outbound. It does
not provide anonymity. Its provider may observe connection metadata and content where it terminates
encryption. It has a changing address and no uptime guarantee. A stable deployment should use a
stable address and deliberate service management. See
[Cloudflare's documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

### F7. Local ignored artifacts do not match the current release

**Priority 2. Confirmed local environment problem, not a release defect.** The existing checkout's
members proving key and members witness module matched the manifest. Both heavy witness modules and
both heavy proving keys did not. The heavy keys were still approximately 2.283 GB each, from the
previous setup. Git was clean before documentation edits because these artifacts are ignored.

The original files were left untouched. A separate temporary checkout fetched the current release
and successfully ran registration and admission. Before using this checkout for proving, its owner
should refresh the necessary artifacts using `scripts/fetch_keys.sh --large registration` and confirm
its checksum results. Preserve any intentional older experiment outside the active build path.
Do not delete unrelated files as cleanup or treat a green source tree as an artifact verification.

### F8. Moderator exclusion is not implemented for Discord

**Priority 1 if exclusion is a launch requirement. Existing acknowledged design limit.** The bot's
member permission allow can override role denies. A manually set member deny also cannot be assumed
to survive the bot updating that overwrite. The project instructions correctly record this limitation.
This review does not propose role denies as a solution.

If a moderator must exclude a specific account, admission must consult a bot-owned exclusion policy,
with defined behavior for existing grants, restarts, and re-verification. Agree on that policy before
implementing it. A small trusted testnet pilot can explicitly accept the limitation. An ordinary
community that expects bans or individual exclusions cannot quietly assume it is already supported.

### F9. The lean installation still reports dependency advisories

**Priority 2 triage. Exposure not established by the count alone.** A fresh
`npm audit --omit=optional --json` reported 19 affected package entries, including five high, two
moderate, and twelve low. That does not mean nineteen distinct remotely reachable vulnerabilities.
Several entries propagate the same advisory through a dependency chain.

Determine which affected functions the gateway, prover, and tooling invoke on attacker-controlled
input. Record the vulnerable function, importing path, input boundary, and resolution for each
reachable case. The report includes `jsonpath` through `bfj`, `brace-expansion`, and `ws` among its
chains. Do not infer that importing a package exercises every vulnerable feature. Do not use a forced
major-version upgrade as a substitute for that analysis. Re-test the actual proving and gateway
paths after compatible dependency updates.

## Documentation repairs completed in this working tree

| Problem found | Repair |
| --- | --- |
| Old two-tier boot examples omitted mandatory registration contexts | Added the allowlist to deployment examples and a tested configuration generator to the moderator guide |
| Runbook mixed obsolete setup with current deployment behavior | Replaced it with a concise entry point to the current operator, member, and privacy guides |
| Deployment guide described removed Discord role mode | Documented current private-channel permission grants and the removed mode |
| Telegram and Matrix examples had broken code fences and repeated prose | Corrected both adapter READMEs and added their actual platform limits |
| General member guide assumed Discord submission everywhere | Added the exact submission action for each platform |
| Setup guidance blurred public proving keys and private credentials | Added a key-purpose table and explicit handling instructions |
| Contribution guide claimed macOS support while downloading Linux code | Rewrote it for Linux x86-64 with compiler verification before execution |
| Contribution instructions blurred source reference and freeze commit | Distinguished the source recorded by the freeze from the reference containing the freeze |
| Ceremony prose implied unconditional privacy from a matching record | Added the proof-privacy assumptions and the forged-admission consequence |
| Prior current-state handoff described resolved findings as current | Added a dated current summary and retained the older record as history |

Root-level files were not edited under the repository-root write boundary. Root overview language
should eventually point to the new moderator and privacy guides. No derived public export repository
or exporter for these files was identified in the inspected project scripts. There was no propagation
or publishing operation in this review.

## What the messages actually show

The [message preview document](MEMBER_MESSAGE_PREVIEWS_2026-09-29.md) contains code-generated examples,
not invented sample copy. It covers both Discord modes, missing gateway configuration, success,
expiry, common refusals, Telegram private and group handling, Matrix direct-room instructions and
results, and the web challenge instructions.

| Surface | Observed behavior | Needed improvement |
| --- | --- | --- |
| Discord | Numbered sections, separate command blocks, channel mention, local timestamps, short reason codes | Accurate privacy sentence, fresh challenge after initial registration, safer command quoting |
| Telegram | Separate document and plain-text instructions, account-bound join request | Enforce private chat, format commands, show challenge deadline, repair renewal and retry wording |
| Matrix | Direct-room privacy check, pasted challenge and proof, invitation result | Explain unsupported encrypted rooms, format commands, repair renewal and retry wording |
| Web | Challenge download and proof upload, example protected page | Show deadlines clearly, remove broad privacy claim, harden session lifecycle and cookies before production |

The representative Discord two-tier message was 1,235 characters. Telegram used a 55-character
caption and a separate 930-character message. The Matrix instruction message was 1,271 characters.
These fit the tested limits. This is not a claim that arbitrary unbounded operator labels always fit.
The full suite includes the previously added long-address and message-splitting checks.

Discord's raw timestamp syntax is shown exactly in the preview. Its intended local rendering is also
explained. A fixture starting September 29 at noon in New York had a 12:10 p.m. deadline and access
ending December 2 at 7 p.m., corresponding to December 3 at midnight Coordinated Universal Time (UTC).
These are fixture dates, not an invitation to use an expired challenge.

No native Discord, Telegram, or Matrix client was driven in this review. No live message was sent.
The preview cannot establish mobile layout, attachment-picker behavior, actual platform permissions,
or delivery to a real account. Those belong in the small live acceptance run.

## Cryptographic and privacy assessment

The project proves control of an eligible voting key. Delegation and shared voting keys mean the
rule that holds is one voting key, one membership in the relevant period and context. It is not a unique
person test, collateral ownership proof, or guarantee that the member personally runs a server.
Changing to an owner key would change both the statement and credential risk. It is not a cosmetic
improvement for this pilot.

The released heavy circuits use Groth16, while recurring members proofs retain the existing PLONK
(Permutations over Lagrange-bases for Oecumenical Noninteractive arguments of Knowledge) proof system. The internal circuit assessment, purpose tags, key-zero rejection, compiler freeze, and
published setup record are meaningful controls. Their presence does not convert a general repository
review into a formal soundness proof. This review did not repeat the entire exceptional-case analysis,
rebuild the ceremony, or independently verify every setup contribution. Existing targeted circuit
checks passed in continuous integration (CI).

The setup secret is not a key for decrypting honest members' proofs under the intended verified
parameters and correct software. Retained setup secrets threaten soundness by enabling forgery.
An unauthorized member admitted through forgery can read the chat, so the application's privacy can
still suffer. Malicious parameters and malicious proving software are separate concerns, and a file
checksum cannot establish their trustworthiness by itself. The new
[privacy document](../SETUP_PRIVACY.md) explains these distinctions and links the technical sources.

Hilawe and Pasta contributing independently to both heavy circuit setups is a reasonable plan. It
requires actual independent randomness and verified transcripts, not two names on one computer's
operations. The public beacon is part of the published procedure, not a replacement for an honest
contribution. The current release remains a single-contributor interim setup until the later ceremony
really occurs and its artifacts replace the pilot keys.

A signed oracle proves that the list came from the pinned signer. It does not by itself prove that the
signer supplied the true current Dash list. Keep that trust explicit. The direct-node commitment and
proof-of-work checks have their own assumptions. They were not revalidated against a new live chain
snapshot during this review.

## Operations and moderator experience

The new [moderator guide](../MODERATOR_GUIDE.md) separates routine moderation from host operation.
Moderators should not need a voting key, ceremony tools, a large proving key, or access to a wallet.
They need a verified service, correct platform permissions, a way to recognize failure states, and a
named operator who owns recovery.

Use one durable gateway for the pilot. The shared Platform backend still relies on coordinated
schedules across gateways and has different re-grant limitations. It adds no necessary benefit to
this acceptance test. Preserve account binding and context-scoped members roots, which are already
implemented rather than open work.

Treat access removal as an operation that can fail. Platform outages, missing permissions, or a stopped
bot can delay revocation. Stopping the gateway does not revoke existing platform permissions. Backups
must preserve the mutually related registration, nullifier, grant, and clock state. A crash recovery
check is different from an empty fresh-install check. Do not reset state simply to make a demo pass.

For Telegram, start with a disposable private group and inspect its existing roster before recording
reconciliation. Do not silently grandfather users the proof system never admitted. For Matrix, an
invite-only room with joined-only history is not end-to-end encryption. The adapter does not decrypt
encrypted events. For web deployment, the current cookie lacks `Secure`, sessions live in memory,
and the example page does not protect resources in another application. Those are explicit production
limitations, not reasons to delay the narrowly scoped Discord test.

## Efficiency and future direction

Do not start another proof-engine migration to solve the old 2.3 GB problem. The current released key
already addresses most of that download burden. Spend the next effort on the complete member journey.
The first useful metric is whether a new person can get admitted without sending a secret or asking
for repeated help, then lose access correctly at the boundary.

- Keep selective key fetching. One `--large registration` invocation includes the common artifacts,
  so an earlier default fetch is redundant. The current common bundle includes the unused single-tier
  witness module, an approximately 7.9 MB optimization opportunity with much less impact than the
  completed key reduction.
- Add a bounded preflight command after the pilot. Check the source and manifest identity, checksums,
  reachable gateway, supported mode, context, oracle freshness, free disk, and private secret-file
  permissions. Report an actionable error without printing secrets. Avoid creating another general
  monitoring framework.
- Consider a guided local client that performs setup checks, registration, fresh challenge handling,
  and proof export. Keep custody local. Do not offer a hosted prover that accepts members' voting keys
  merely to make the interface simpler.
- Reconsider single-tier versus two-tier only after the pilot. When access period equals season,
  members normally make one admission proof per registration. Groth16 has reduced the heavy cost,
  so two-tier registration and secret recovery no longer have the same automatic amortization case
  as the old weekly workflow. Two-tier still enables cheap retries and later proofs without reusing
  the voting key. Compare complete user effort, revocation, recovery, and privacy before changing it.
- Keep the standalone circuit checker extraction small if pursued. Publish a narrow scope, pinned
  inputs, contrary controls, and limits. It should not become a new prerequisite for admitting Pasta
  or a claim that arbitrary circuits have been audited.

For the next measurement, use Pasta's Linux machine, one reviewed revision, the matching released
keys, the intended remote gateway, and a fixed stop condition. Record download bytes, available memory,
registration time, proof time, failure recovery, and platform access. Do not compare its time directly
with this one-leaf local Mac run as though the environments were interchangeable.

## Evidence and limits

| Check | Result |
| --- | --- |
| Complete installed Node test suite in isolated source copy | 804 passed, zero failed, zero skipped, about 104 seconds |
| Exact reviewed commit on GitHub | `full`, `checks`, and `circuits` all successful |
| Current release download | All five requested artifacts checksum-verified |
| Signed local oracle and authenticated adapter | Real released-key registration and admission succeeded |
| Unauthorized challenge | Refused with status 401 |
| Replay of accepted membership proof | Refused with status 410 and `unknown-or-expired-challenge` |
| Cryptographic check after changing the members root | Rejected |
| Adapter message execution | Discord formatter plus Telegram, Matrix, and web handlers captured |
| Telegram group contrary control | Demonstrated challenge and success disclosure |
| Guide commands | Twenty-five Bash blocks passed syntax checking |
| Moderator configuration block | Executed, loaded, context and oracle pin validated, private permissions confirmed |
| Lean dependency audit | Nineteen affected package entries, reachability still requires triage |
| Live Linux, wallet, remote host, tunnel, and platform clients | Not exercised in this review |
| New mainnet list or full ceremony verification | Not performed in this review |

The exact CI run is [36601215085](https://github.com/hilawe/dash-mno-verify/actions/runs/36601215085).
It validates the committed baseline. It does not contain these uncommitted documentation changes.
The local full suite used the installed full dependency tree. The separate lean installation is
covered by the recorded `checks` job and the dependency audit, not by claiming a second local install.

Machine-readable evidence and the two temporary execution probes were delivered with the review in a
separate handoff bundle, not in this repository. The synthetic probe's local signing and voting keys are not handoff artifacts.
Message fixtures use example domains and identifiers. The source checkout's stale proving files and
any existing member secrets were neither copied nor deleted.

## Bounded next unit

Complete one Discord pilot with Pasta using the reachable member address and the Linux walkthrough.
Repair consequential message or deployment defects needed for that path, then perform one focused
confirmation. Telegram's guard can be a small separate unit before its own pilot. Do not reopen every
circuit and adapter because a sentence changes.

The acceptance record should show a fresh ordinary account admitted, the wrong account refused,
an expired challenge recovered, a same-account retry handled, and access removed at the configured
boundary in a disposable test environment. Include a restart with durable state intact. Keep live
platform confirmation distinct from already passing local and CI tests.

The work is reviewable in the working tree. Nothing was committed, pushed, deployed, or messaged to
Pasta. The host-owner exposure decision and actual ceremony participation remain external actions.
