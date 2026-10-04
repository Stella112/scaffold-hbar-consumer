# Open questions (M0 classification)

Status: **VERIFIED** (answer in docs/SOURCES.md) · **BLOCKED** (needs a decision or external change) · **NOT_NEEDED**.

| ID | Question | Status | Notes |
| --- | --- | --- | --- |
| U1 | External-template CLI syntax | VERIFIED | `npx create-scaffold-hbar@latest --template <owner>/<repo>[#branch]` (third-party docs + parser source). `npm create scaffold-hbar@latest -- --template …` is the npm-create equivalent of the same package. |
| U2 | Hedera JS SDK package | VERIFIED | `@hiero-ledger/sdk` (used by the official template; npm latest 2.89.1). |
| U3 | HTS / HIP-904 Solidity interface | VERIFIED | hiero-contracts `IHederaTokenService.sol`: `airdropTokens`, `claimAirdrops`, `cancelAirdrops`. Live behaviour checked by `yarn prove:testnet` flow 5. |
| U4 | HSS / HIP-1215 interface | VERIFIED | `scheduleCall` is live on testnet (`hasScheduleCapacity` true, 2026-10-03). Recurring payments use it; `yarn prove:testnet` flow 10. |
| U5 | SaucerSwap V2 router + quoter | VERIFIED | Router 0.0.1414040, QuoterV2 0.0.1390002 — docs + bytecode + live calls. |
| U6 | Viable testnet pair | VERIFIED | USDC(0.0.5449)/WHBAR 0.30% and WHBAR/SAUCE 0.30% pools with liquidity; live quotes recorded. |
| U7 | Supra oracle deployment/feed for caps | VERIFIED | Supra push storage on testnet `0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917` (docs.supra.com networks page); HBAR_USD = 432, USDC_USD = 89 (data-feeds index), read live. `SupraPriceOracle` 0.0.10844780. Pyth testnet prices are weeks old and Hermes now requires an API key. |
| U8 | x402 Hedera package | VERIFIED | `@x402/core` / `@x402/hedera` 2.28.0. |
| U9 | `transferExecutor` implementation | RESOLVED IN TEMPLATE | Still absent from `@x402/hedera@2.28.0`. This template implements it on `@x402/core` per `scheme_exact_hedera.md`: `TransferExecutorFacilitator` (relayer) + `TransferExecutorClient` (SDK). `yarn prove:testnet` flow 6. |
| U10 | Facilitator support for `transferExecutor` | RESOLVED IN TEMPLATE | Option (a): self-hosted facilitator in the app (`/api/x402/facilitator/*`), sponsor account as fee payer. |
| U11 | Contract verification path | VERIFIED | Sourcify (`forge verify-contract --chain-id 296 --verifier sourcify`, solc pinned to 0.8.30): factory and ConsumerAccount `exact_match`, SupraPriceOracle `match`. |
| U12 | Local Hedera system-contract testing | VERIFIED | `hashgraph/hedera-forking` v0.1.2 (`htsSetup()`), plus clearly named mocks (`MockHederaTokenService`) for unit tests. Testnet proofs never use mocks. |
| U13 | Demo token IDs | VERIFIED | USDC 0.0.5449, WHBAR 0.0.15058 (contract 0.0.15057), SAUCE 0.0.1183558. |
| U14 | `template.json` schema | VERIFIED | zod `TemplateManifestSchema` in create-scaffold-hbar `src/types.ts`. |

## Other open items

- **Gas estimation for HTS calls via Hashio**: the relayer pads `eth_estimateGas` by 30% (min 150k). Confirmed on testnet that it underestimates HIP-904 airdrops, so airdrops get a 2.5M gas floor.
- **Auto-association of EVM-created contracts**: ConsumerAccount always associates explicitly through `associateToken` (response code checked) rather than relying on auto-association.
