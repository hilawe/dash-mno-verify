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

## What it guarantees

- Privacy. The bot learns only that some masternode vouched for this person. It never learns which one, and never an address.
- One membership per node. Each masternode can claim only one membership in a given time window, so a single node cannot farm many. Each proof carries a unique anonymous tag that the doorman tracks to block a second claim, and that tag cannot be traced back to a node.
- Access that tracks current control. If the masternode is sold, the seller cannot produce a valid proof in the next window, so their access lapses on its own.
- No tracking across communities. The same person produces a different anonymous tag in each community, so memberships in different places cannot be linked together.

## What it does not do yet

- It is a working prototype, not a professionally audited system. It has had a careful, adversarial self-review, which is valuable but is not the same as a formal audit.
- Making a proof asks a lot of the member's computer. It needs a large helper file of about 2.3 GB, downloaded once, and it runs some heavy computation. That step on the member's side is the main rough edge for wide adoption.
- The doorman trusts the list keeper to report the masternode list honestly. Today that is softened by having the keeper sign the list, and by optionally running several independent keepers, so forging the list would mean compromising a quorum of them rather than one machine. The known next step removes the keeper from the trust entirely, by having the doorman check the list against Dash's own on-chain record of the masternode set that every node already agrees on. That is real work because the doorman would have to verify chain data the way a light Dash node does, and because the chain stores the list in a different form than the proof system uses, so the two cannot be compared directly without rebuilding one from the other. The design already signs the block reference this check would build on.
