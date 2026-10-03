# Build state

**Updated:** 2026-10-03 · **Current milestone:** M2 (sponsored testnet proof) — blocked on operator credentials.

## Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| `forge fmt --check`, `forge build`, `forge test` | PASS | 60 tests (owner intents, session policy, x402 executor, recovery, factory, swap-to-pay) |
| SDK typecheck + tests | PASS | 15 tests incl. Anvil e2e with compiled contracts |
| Relayer typecheck + tests | PASS | 12 tests incl. full sponsor pipeline on Anvil |
| Scripts typecheck | PASS | |
| `yarn doctor` | runs | live chain-id / Mirror / SaucerSwap checks PASS; operator env missing |
| M1 account + policy | VERIFIED_LOCAL | `docs/SECURITY_INVARIANTS.md` |
| M2 zero-HBAR sponsored flow | NOT RUN on testnet | needs `.env` operator → `yarn bootstrap --fund` → `yarn prove:testnet` |
| M3 payments + HIP-904 | contract + proof script ready, NOT RUN | flows 3, 5 |
| M4 SaucerSwap swap-to-pay | contract + proof script ready, NOT RUN | flow 4 |
| M5 agent / MCP / x402 | partial: on-chain policy + executor done; MCP, x402 resource, oracle not built | U7, U9, U10 blocked |
| M6 recovery + HSS | recovery VERIFIED_LOCAL; HSS not built | |
| M7 vault / launchpad | not started | |
| Next.js app (consumer UI) | template only | |
| Fresh external scaffold gate | not run | |

## Live deployments

None yet (`packages/sdk/deployments/testnet.json` is empty until bootstrap runs).

## Blockers

1. `.env` with a funded ECDSA operator (owner action).
2. Disk space on the build machine (~1.4 GB free).
3. U7 oracle, U9/U10 x402 transferExecutor support (owner decision).

## Next concrete task

Run `yarn bootstrap --fund` and `yarn prove:testnet` as soon as the operator exists; meanwhile build the consumer UI on the shared SDK/relayer.
