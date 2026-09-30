# What the setup ceremony means for privacy

The ceremony does not collect anyone's voting key, collateral key, wallet, member secret, or proof of
masternode control. Hilawe and Pasta can contribute to both circuit setups on separate computers
without exchanging any of those secrets. A contributor does not need a masternode to participate.

**The setup secret is not a decryption key for members' proofs.** For correctly generated and verified
Groth16 parameters and a correct prover, keeping the setup randomness does not reveal an honest
member's voting key or which masternode their proof used. The setup trust concerns whether an attacker
can forge an accepted proof. These are different security properties.

This does not support the broader sentence "the ceremony can never compromise privacy." Forged
membership could admit someone who should not be in the private chat, exposing conversations to them.
Malicious software, substituted parameters, and network or timing information are separate ways to
compromise privacy. A safe explanation must cover both the proof and the community using it.

## What each kind of key does

| Item | Who has it | Purpose | Share it? |
| --- | --- | --- | --- |
| Voting private key | Member | Authorizes their seasonal registration proof | Never send it to a moderator, coordinator, or bot |
| Member secret file | Member | Authorizes subsequent membership proofs that season | Keep private and back it up securely |
| Proving key | Anyone | Public mathematical parameters used to generate a proof | Yes |
| Verification key | Gateway and anyone checking proofs | Public parameters used to verify a proof | Yes |
| Setup contribution randomness | Its contributor, temporarily | Removes reliance on other contributors destroying their randomness | Never publish or retain it |
| Oracle signing key | Oracle operator | Authenticates the published masternode list | Keep the private signing key private |
| Adapter bearer secret | Gateway and adapters | Authenticates requests that identify platform accounts | Never give it to members or put it in public instructions |

The large downloaded proving key is public. It is not a wallet key. Contributing randomness to setup
is also separate from registering as a member. Neither task requires moving collateral or giving
anyone a wallet backup.

## What honest setup contributions protect

The two heavy circuits each have their own setup. At least one participant in each setup must generate
an independent secret contribution on a trustworthy machine and keep it unknown to attackers, then
discard it. Under the proof system's assumptions and a correctly verified setup chain, that prevents
an attacker from reconstructing the setup trapdoor and forging membership.

Hilawe and Pasta contributing separately provides this independence only if they actually use separate
machines and independently generated randomness. Merely attaching two names to operations on one
machine does not. Both participants should contribute to both setups and independently check the final
transcripts. The public beacon completes the published procedure and does not substitute for private
contributions. See [the ceremony procedure](CEREMONY.md).

Closing a terminal is not proof of secure erasure. Avoid recorded terminal sessions, copied entropy,
shared machines, and retained machine snapshots during contributions. The public `.zkey` output files
and contribution hashes are safe to retain. The participant guide distinguishes those public artifacts
from private randomness.

## What proof privacy does and does not cover

For the verified circuits, the proof hides the private voting key and the selected masternode-list
entry. Public proof inputs and the surrounding application still reveal information.

- The adapter knows the platform account being admitted. Moderators and fellow members can see who
  is in the private channel or group.
- The gateway sees registration and members-tree requests. A tunnel or reverse-proxy provider may
  also see connection metadata and, where it terminates encryption, request contents.
- Proving from a masternode's advertised network address can identify that node. Prefer a separate
  computer and network for the pilot. Tor requires an explicitly configured and tested network path.
  Opening Tor Browser alone does not route the command-line prover through Tor.
- Timing and a very small eligible set can make an identity inferable even when the proof hides its
  witness correctly. A one-person pilot checks functionality, not strong anonymity.
- A forged membership could expose the private chat to an unauthorized reader even though it does
  not decode another member's proof.

Independent verification of a setup transcript and checking a download checksum are different checks.
A checksum establishes that a file matches the published release manifest. It does not by itself prove
that the manifest or setup was trustworthy. Contributors check each setup against the frozen compiled
circuit and phase-one input. Members rely on that published verification and the reviewed release unless
they repeat the verification themselves.

## Current pilot status

The `circuit-keys-v3` release uses interim single-contributor heavy keys, recorded in
`circuits/ceremony/INTERIM_SETUP.json`. It is not the planned two-person ceremony. Treat the current
pilot as a test of the workflow with that explicitly stated soundness assumption. Do not describe its
setup as independently contributed or the application as audited.

The proof-system privacy claim assumes the intended verified parameters, correct software, and correct
proof randomness. Research on malicious parameter generation treats resistance to a subverted setup
as a separate property. This repository has not established an unconditional guarantee against every
such attack.

## Suggested explanation for members

> The setup ceremony uses no member voting keys and gives its participants no key for decoding members'
> proofs. With the verified parameters and correct software, the proof hides your voting key and which
> masternode you used. Destroying setup randomness protects against forged membership. Your platform
> account, connection metadata, and private-chat access remain separate privacy considerations.

## Technical sources

- [Groth's proof-system paper](https://eprint.iacr.org/2016/260) defines the construction and its
  security model. It does not establish this application's complete operational privacy.
- [snarkjs setup and verification documentation](https://github.com/iden3/snarkjs) explains
  circuit-specific contributions and checking keys against the compiled circuit.
- [Subversion-zero-knowledge research](https://eprint.iacr.org/2017/587) distinguishes ordinary
  proof privacy from security when parameters are maliciously generated.
