# Build state

**Updated:** 2026-10-03 · **Current milestone:** M2–M4 verified on testnet; public app deployed.

## Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| `forge fmt --check`, `forge build`, `forge test` | PASS | 60 tests (owner intents, session policy, x402 executor, recovery, factory, swap-to-pay) |
| SDK typecheck + tests | PASS | 19 tests incl. Anvil e2e with compiled contracts |
| Relayer typecheck + tests | PASS | 12 tests incl. full sponsor pipeline on Anvil |
| Scripts typecheck | PASS | |
| lint / typecheck / test / build (Linux VPS, fresh clone) | PASS | |
| `yarn doctor` | PASS | no FAIL; WARNs are oracle + x402 (blocked externally) |
| M1 account + policy | VERIFIED_LOCAL | `docs/SECURITY_INVARIANTS.md` |
| M2 zero-HBAR sponsored flow | VERIFIED_TESTNET | `TESTNET_VERIFICATION.md` flows 1–2 |
| M3 payments + HIP-904 | VERIFIED_TESTNET | flows 3, 5 |
| M4 SaucerSwap swap-to-pay | VERIFIED_TESTNET | flow 4 |
| Agent red team / raw-call bypass | VERIFIED_TESTNET | flows 8, 9 |
| M5 agent / MCP / x402 | partial: on-chain policy + executor done; MCP, x402 resource, oracle not built | U7, U9, U10 blocked |
| M6 recovery + HSS | recovery VERIFIED_LOCAL; HSS not built | |
| M7 vault / launchpad | not started | |
| Next.js app (consumer UI) | DEPLOYED | https://hbar.38-49-209-149.sslip.io (systemd `scaffold-hbar-consumer`, Caddy) |
| Fresh external scaffold gate | not run | `yarn check:scaffold` |

## Live deployments (testnet)

| Item | ID |
| --- | --- |
| ConsumerAccountFactory | 0.0.10841522 (`0xa5659e0f3bd8812a86f20e41cfdc1ce301d1c69a`) |
| HCS audit topic | 0.0.10841526 |
| Sponsor | 0.0.10841387 |
| Merchant | 0.0.10841388 |
| Unassociated recipient | 0.0.10841389 |

## Fixes found by the testnet run

- Factory deploy needs ~4.55M gas (embeds ConsumerAccount creation code): bootstrap now estimates.
- viem's EIP-1559 fee estimate fell below the relay minimum: chain definition now quotes `eth_gasPrice`.
- HIP-904 airdrops: `eth_estimateGas` does not model the pending-airdrop charge; relayer uses a 1.5M gas floor.
- New accounts need a few seconds to index on Mirror Node before association checks.

## Blockers

1. U7 oracle, U9/U10 x402 transferExecutor support (owner decision).

## Next concrete task

Fresh external scaffold gate (`yarn check:scaffold`).
