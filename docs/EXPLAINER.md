# What this is, in plain language

A short explainer for a non-specialist reader. It describes what the system does, why it is useful, and how it works, without assuming any cryptography background. For the technical depth, see [DESIGN.md](DESIGN.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

## The idea in one line

It lets someone prove they control a Dash masternode without revealing which one, so a private space can be gated to real masternode holders without anyone having to expose their node, their address, or their holdings.

## The problem it solves

A Dash masternode requires 1,000 DASH locked up as collateral. Because of that, "controls a masternode" is a strong signal that someone is a serious, invested stakeholder. That makes it appealing to gate a private channel, for example in a community Discord, to masternode holders only.

The obvious way to check is to make people prove it, by signing a message with their masternode key or by showing the node's address. The trouble is that this exposes them. It ties a chat identity to an on-chain address, and through that to a specific node and a holding of 1,000 DASH. Most serious holders will not accept that, and they are right to be cautious about it.

This system gives the proof without the exposure.

## The trick that makes it work

Dash already publishes a list of every masternode on its blockchain. Anyone can see the whole list. Controlling a masternode means holding the secret key that matches one entry on that public list.

Picture a wall of several thousand locked mailboxes, with a public chart of which key shape opens which box. You want to prove to a doorman that you hold a key to one of the boxes, without showing which box is yours and without letting him see your key. You hand him a kind of certificate. He can check that the certificate is genuine, that it could only have been produced by someone who holds a real key to one of the boxes, and yet it tells him nothing about which box or which key is yours.

That certificate is what cryptographers call a zero-knowledge proof. It proves a statement is true while revealing none of the facts behind it. That single idea is the heart of the system.

## The four moving parts

1. The list keeper (called the oracle). It reads the public masternode list from a Dash node and packages it into a form the proof system can use, then publishes it. Because its input is public, anyone can rebuild it and catch a dishonest keeper.
2. The prover. This runs on the member's own computer. They feed in their masternode secret key, which never leaves their machine, along with the published list. Out comes the proof, which carries no secret.
3. The doorman (called the gateway). It receives a proof, checks it against the current list, and answers yes or no. It never sees the key or learns which masternode is involved.
4. The front door (called the adapter). This is the thin layer that talks to the chat platform. For Discord it hands the member a challenge, takes their proof, passes it to the doorman, and on a yes assigns the role. The same doorman serves Discord, Telegram, a website, and more, so each platform only needs its own small front door.

An operator who runs their own Dash node can now skip the list keeper altogether and have the doorman read the list straight from that node. That removes a whole party from the arrangement, along with the signing keys and the transport that went with it. What it does not remove is trust in the node itself, which is covered under the limits below.

## What it guarantees

- Privacy. The bot learns only that some masternode vouched for this person. It never learns which one, and never an address.
- One membership per node. Each masternode can claim only one membership in a given time window, so a single node cannot farm many. Each proof carries a unique anonymous tag that the doorman tracks to block a second claim, and that tag cannot be traced back to a node.
- Access that tracks current control. If the masternode is sold, the seller cannot produce a valid proof in the next window, so their access lapses on its own.
- No tracking across communities. The same person produces a different anonymous tag in each community, so memberships in different places cannot be linked together.

## What it does not do yet

- It is a working prototype, not a professionally audited system. It has been reviewed repeatedly and adversarially, which is valuable and is not the same as a formal audit by a security firm.
- Making a proof asks a lot of the member's computer. There are two ways to run the system. The simple one makes a full proof every time, which needs a helper file of about 2.3 GB downloaded once and several minutes of heavy computation, measured at just under five minutes on one test machine. The other splits the work, so the expensive proof happens once a season and the routine proof that runs the rest of the time uses a 35 MB helper file instead. The heavy step is still the main rough edge for wide adoption, and reducing it is an open line of work with its own notes in the repository.
- The doorman still has to trust something about where the list came from, though less than before. Part of that trust has moved, and part of it has not.

  Dash's own blockchain carries a fingerprint of the masternode list inside every block, and the network's rules require it to match. The doorman now rebuilds that fingerprint from the list it was handed and refuses the list if the two disagree. It reads the fingerprint out of the block's own contents rather than believing a summary the node offers alongside it, which is the difference between checking a document and taking someone's word for what the document says. That was verified against live Dash mainnet data, on a block with 2,971 masternodes in it.

  The doorman also now checks that the block is a real block. Dash names each block by running its header through eleven hashing steps in sequence, and producing a header whose name comes out to a particular value is the work that mining consists of. The doorman does that calculation itself, confirms the block is the one it was told about, and confirms that enough work went into it. So a node can no longer invent a block, because inventing one now means mining one.

  What remains is narrower than it was. Dash's fastest confirmation, called a ChainLock, is a signature from a group of masternodes saying a block is settled. The doorman is told a block has one and does not check that signature, so a node could offer a genuine but old block, or one mined at the lowest difficulty the network permits, which costs real effort but far less than the current chain. Closing that means either following the chain of blocks the way a lightweight wallet does, or checking the ChainLock signature itself. Neither is built. The practical summary is that a node can no longer make things up for free, and a determined node with real resources is not yet ruled out.
- The most recent independent review raised findings that are not all fixed. Several findings are closed, including the ones about how the system proved its own claims to itself. Others are open and are recorded in the repository rather than left implicit, among them the trust gap described just above. The repository keeps its review findings in public alongside the code, which is deliberate.

## Where the work stands, August 2026

Recent work went in three directions, and it is worth separating them because they carry different weight.

The largest piece is the on-chain check described above, which moves the masternode list from something the doorman accepts on trust toward something it verifies. All four steps it needs are now built and confirmed against real Dash mainnet data, including the eleven-step hashing method Dash uses to name blocks, which had to be written from scratch and is checked against the reference implementation and against real block names from the first block to the current one. What is left is the ChainLock signature and the question of mining difficulty, described above.

A second strand closed three findings from the independent review. One was a real defect in how registrations are written to disk, where an error at the wrong moment could tell a member their registration failed while it had in fact been saved, and the retry then saved it twice, which changed the shared record of members after a restart. One was that the doorman could discard a list a member was in the middle of proving against, so their correct proof was refused through no fault of their own. The third could cost a member their access for a period if the network dropped a message at the wrong moment, and that one is not fixed. The feature it affects now refuses to run unless the operator explicitly accepts the risk.

The second is unglamorous internal work. The doorman's code was restructured so its behaviour can actually be tested, and a limit was put on how much memory it holds while lists change over. Neither changes what a member sees. Both matter because most of the defects found in this project have been in recently written code, so the ability to test a change is worth more than any single fix.

The third is the review discipline itself. Every substantial change here is checked by reviewers that did not write it, and the record of what they found, including the mistakes, is kept in the repository. Several defects this month were caught that way rather than by the author, which is the point of doing it.

None of this makes the system audited. It remains a working prototype, and the advice at the top of the repository stands, which is not to use it to gate anything of real value yet.
