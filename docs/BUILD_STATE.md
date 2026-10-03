# Build state

**Updated:** 2026-10-04 · **Status:** all planned features built and verified on Hedera testnet; live app deployed.

## Gates

| Gate | Status | Evidence |
| --- | --- | --- |
| `forge fmt --check`, `forge build`, `forge test` | PASS | 112 tests: owner intents, session policy, x402 executor, recovery, factory, swap-to-pay, Supra oracle (incl. fuzz), HSS subscriptions, savings vault, launchpad |
| SDK / relayer / MCP tests | PASS | 19 / 22 / 3 (incl. Anvil e2e, x402 settlement-record conformance, MCP over in-memory transport) |
| lint / typecheck / build (Linux VPS, fresh clone) | PASS | |
| Fresh external scaffold gate | PASS | `yarn check:scaffold` (rerun on final code before submission) |
| `yarn doctor` | PASS | no FAIL |
| Contract source verification | PASS | Sourcify `exact_match`: factory, ConsumerAccount, SupraPriceOracle, SavingsVault, TokenLaunchpad |

## Features → testnet proof (`TESTNET_VERIFICATION.md`)

| Feature | Status | Flow |
| --- | --- | --- |
| Sponsored account creation, zero-HBAR controller | VERIFIED_TESTNET | 1, 2 |
| HTS payment, SaucerSwap swap-to-pay, HIP-904 airdrop | VERIFIED_TESTNET | 3, 4, 5 |
| x402 exact / transferExecutor (settle, replay, tampering) | VERIFIED_TESTNET | 6 |
| MCP agent against the deployed app | VERIFIED_TESTNET | 7 |
| Supra-priced session caps + red team | VERIFIED_TESTNET | 8 |
| Raw-call bypass (relayer + on-chain + HCS) | VERIFIED_TESTNET | 9 |
| HSS recurring payments | VERIFIED_TESTNET | 10 |
| Savings vault | VERIFIED_TESTNET | 11 |
| Token launchpad | VERIFIED_TESTNET | 12 |
| Guardian recovery | VERIFIED_LOCAL | Foundry `RecoveryTest` |

## Live deployments (testnet)

| Item | ID |
| --- | --- |
| ConsumerAccountFactory | 0.0.10848625 (`0x6a882cd5a6f13960eefcd1290282e550eef81aae`) |
| SupraPriceOracle | 0.0.10844780 |
| SavingsVault (WHBAR) | 0.0.10848627 |
| TokenLaunchpad | 0.0.10848836 |
| HCS audit topic | 0.0.10841526 |
| Sponsor / merchant / unassociated | 0.0.10841387 / 0.0.10841388 / 0.0.10841389 |
| App | https://hbar.38-49-209-149.sslip.io (systemd `scaffold-hbar-consumer`, Caddy) |

## Findings from testnet (fixed or documented; see `docs/HEDERA_GOTCHAS.md`)

- Factory deploy needs ~5.6M gas; bootstrap estimates.
- viem's EIP-1559 fee estimate fell below the relay minimum; the chain definition quotes `eth_gasPrice`.
- `eth_estimateGas` misses HTS fees charged as gas (airdrops, association): airdrop gas floor + `minGas` on intents.
- HBAR from a contract to an aliased account's long-zero address fails; recipients resolve to the alias.
- `block.timestamp` lags consensus in scheduled calls; instalments are scheduled 10 s after due.
- HSS `scheduleCall` costs a flat ~1.54M gas; scheduled instalments get 2M.
- Contract-initiated HIP-904 airdrops are paid by the contract; launchpad claims fund their own fee.
- Pyth Hermes now needs an API key; Supra push feeds are used.

## Known limitations

See README "Limitations" and `SECURITY.md` (airdrop fees outside session caps; factory size margin).
