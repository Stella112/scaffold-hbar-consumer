# Open questions (M0 classification)

Status: **VERIFIED** (answer in docs/SOURCES.md) · **BLOCKED** (needs a decision or external change) · **NOT_NEEDED**.

| ID | Question | Status | Notes |
| --- | --- | --- | --- |
| U1 | External-template CLI syntax | VERIFIED | `npx create-scaffold-hbar@latest --template <owner>/<repo>[#branch]` (third-party docs + parser source). `npm create scaffold-hbar@latest -- --template …` is the npm-create equivalent of the same package. |
| U2 | Hedera JS SDK package | VERIFIED | `@hiero-ledger/sdk` (used by the official template; npm latest 2.89.1). |
| U3 | HTS / HIP-904 Solidity interface | VERIFIED | hiero-contracts `IHederaTokenService.sol`: `airdropTokens`, `claimAirdrops`, `cancelAirdrops`. Live behaviour checked by `yarn prove:testnet` flow 5. |
| U4 | HSS / HIP-1215 interface | VERIFIED (interface) | `IHRC1215.sol` signatures recorded. Deployed behaviour not yet exercised; recurring payments are not implemented yet. |
| U5 | SaucerSwap V2 router + quoter | VERIFIED | Router 0.0.1414040, QuoterV2 0.0.1390002 — docs + bytecode + live calls. |
| U6 | Viable testnet pair | VERIFIED | USDC(0.0.5449)/WHBAR 0.30% and WHBAR/SAUCE 0.30% pools with liquidity; live quotes recorded. |
| U7 | Supra oracle deployment/feed for caps | **BLOCKED** | Not yet verified. Without a verified oracle, every session spend fails closed with `PRICE_UNAVAILABLE` (by design). Decision needed: verify Supra, or ship caps as fail-closed only. |
| U8 | x402 Hedera package | VERIFIED | `@x402/core` / `@x402/hedera` 2.28.0. |
| U9 | `transferExecutor` implementation | **BLOCKED** | Specified in `scheme_exact_hedera.md`; **not implemented** in `@x402/hedera@2.28.0`. ConsumerAccount implements `ITransferExecutor` (selector 0xea8f19fd, unit-tested). |
| U10 | Facilitator support for `transferExecutor` | **BLOCKED** | No published facilitator advertises it. Options: (a) self-host a facilitator implementing the spec's transferExecutor method, (b) labelled "X402 compatibility fallback" ECDSA payer using `cryptoTransfer`. Needs owner decision (BUILD_PROMPT §60). |
| U11 | Contract verification path | VERIFIED (path) | Sourcify via `forge verify-contract --chain-id 296 --verifier sourcify` (template foundry.toml/Makefile). Not yet executed. |
| U12 | Local Hedera system-contract testing | VERIFIED | `hashgraph/hedera-forking` v0.1.2 (`htsSetup()`), plus clearly named mocks (`MockHederaTokenService`) for unit tests. Testnet proofs never use mocks. |
| U13 | Demo token IDs | VERIFIED | USDC 0.0.5449, WHBAR 0.0.15058 (contract 0.0.15057), SAUCE 0.0.1183558. |
| U14 | `template.json` schema | VERIFIED | zod `TemplateManifestSchema` in create-scaffold-hbar `src/types.ts`. |

## Other open items

- **Gas estimation for HTS calls via Hashio**: the relayer pads `eth_estimateGas` by 30% (min 150k). To be confirmed on the first testnet run.
- **Auto-association of EVM-created contracts**: ConsumerAccount always associates explicitly through `associateToken` (response code checked) rather than relying on auto-association.
