# Ideas (not in scope)

- Passkey-gated controller key (WebAuthn → secp256k1 wrapper) as an optional auth adapter.
- Per-merchant spending categories in session policy.
- Pending-airdrop auto-claim reminder for recipients.
- Sponsor policy plug-ins (allow only specific merchants/tokens).

## Future: CLPR Cross-Ledger Settlement

**Status: FUTURE / POST-BOUNTY / DO NOT IMPLEMENT**

CLPR could become a future extension of Scaffold-HBAR Consumer once it has stable, publicly verifiable developer
interfaces and a live environment we can test against.

The future architecture would add a typed action such as:

- `cross-ledger-payment`
- `cross-ledger-settlement`

A ConsumerAccount or authorized AI agent could initiate a cross-ledger workflow while the existing policy engine
controls:

- destination ledger;
- destination application;
- recipient;
- asset;
- amount;
- per-call limit;
- daily limit.

Potential future use cases include cross-border payments, institutional settlement and movement between supported
public/private ledgers.

Architecturally, CLPR should become another typed action adapter, not a replacement for ConsumerAccount or a new core
account architecture.

### Do not implement this now

CLPR is future scope only for the current build. Do not add CLPR packages, contracts, another chain or cross-ledger
code; do not modify ConsumerAccount for CLPR; do not add CLPR to the README's current feature claims, the current demo
or `prove:testnet`; and do not spend engineering time researching an implementation unless specifically instructed
later.

Reason: CLPR is still early-stage and we do not currently have a sufficiently verified live integration path for this
submission. The current priority is completing and proving the existing Scaffold-HBAR Consumer architecture.
