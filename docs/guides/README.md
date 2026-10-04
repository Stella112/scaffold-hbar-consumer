# Guides

How Scaffold-HBAR Consumer works, one topic per page. Every claim here is backed by code and tests in this
repository; Hedera behaviour is backed by `TESTNET_VERIFICATION.md` (`yarn prove:testnet`).

| Guide | Covers |
| --- | --- |
| [architecture](architecture.md) | Packages, request flow, the two enforcement layers |
| [account-model](account-model.md) | ConsumerAccount, factory, owner intents, nonces, session actions |
| [sponsorship](sponsorship.md) | Zero-HBAR controllers, the relayer pipeline, budgets, faucet, receipts |
| [policy-and-agents](policy-and-agents.md) | Sessions, typed actions, USD caps, Supra oracle, fee caps, red team |
| [payments](payments.md) | Payments, signed requests, QR, swap-to-pay, HIP-904 delivery and claims |
| [x402](x402.md) | Paid HTTP resources, the transferExecutor facilitator and client |
| [mcp](mcp.md) | The MCP server and its tools |
| [recovery](recovery.md) | Guardians, timelock, cancelling, linking a recovered account |
| [scheduling](scheduling.md) | Recurring payments with the Hedera Schedule Service |
| [vault](vault.md) | Savings vault recipe |
| [launchpad](launchpad.md) | Token launchpad recipe and the launchpad-buy action |
| [custom-actions](custom-actions.md) | Action modules and `yarn new:action` |
| [testnet-proof](testnet-proof.md) | `doctor`, `bootstrap`, `prove:testnet`, evidence statuses |

Also: [`../SECURITY_INVARIANTS.md`](../SECURITY_INVARIANTS.md), [`../HEDERA_GOTCHAS.md`](../HEDERA_GOTCHAS.md),
[`../DECISIONS.md`](../DECISIONS.md), [`../../SECURITY.md`](../../SECURITY.md).
