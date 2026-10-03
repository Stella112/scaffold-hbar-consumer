# Decisions

| # | Date | Decision | Reason |
| --- | --- | --- | --- |
| D1 | 2026-10-03 | Fork `hedera-dev/scaffold-hbar` branch `templates/blank-template`, keep Foundry only. | The CLI's documented "fork-first" path; keeps current Next.js/Yarn conventions. One Solidity codebase (no Hardhat). |
| D2 | 2026-10-03 | `@hiero-ledger/sdk` for native Hedera services. | Used by the official template; current npm package. |
| D3 | 2026-10-03 | ConsumerAccount deployed with CREATE2 + constructor (no proxy, no initializer). | Removes the initialization-race class entirely; avoids proxy/delegatecall interaction with HTS. Owner is part of the salt so nobody can claim another owner's address. Runtime 17.7 KB with optimizer. |
| D4 | 2026-10-03 | Owner intents may carry raw calls; sessions only typed actions. A session signature on an owner intent reverts `RawCallForbidden` before any call. | BUILD_PROMPT §29. |
| D5 | 2026-10-03 | Admin functions are `onlySelf`: reachable only through an owner-signed self-call. | One authorization path; sponsor pays for admin operations too. |
| D6 | 2026-10-03 | Owner raw calls to the HTS system contract (0x167) are forbidden; typed helpers (`associateToken`, airdrop action) check response codes. | Invariant 18: HTS returns codes instead of reverting. |
| D7 | 2026-10-03 | Unordered 256-bit nonces (`nonceUsed[nonce]`) shared by owner, session and x402 authorizations. | Parallel requests without ordering; single-use guaranteed. |
| D8 | 2026-10-03 | Session caps are priced in USD6 through `IPriceOracle`; no oracle or `ok=false` → `PriceUnavailable`. Swap-to-pay is priced at `amountInMaximum`. | Fail closed (§55); worst-case pricing for swaps. |
| D9 | 2026-10-03 | Owner rotation (`setOwner` or recovery) increments `ownerEpoch`, invalidating all sessions. | A recovered account must not keep an attacker's sessions. |
| D10 | 2026-10-03 | Swap-to-pay is an internal typed action using an owner-managed router allowlist, exact approval revoked after the swap, and a recipient balance-delta check. | Invariant 17; minimal approvals. |
| D11 | 2026-10-03 | Sponsor relayer is a library (`@sh/relayer`) plus a standalone Node HTTP server; scripts and the frontend reuse the same `Sponsor` class. | No duplicated sponsorship logic; deployable serverless or long-running. |
| D12 | 2026-10-03 | Denials are audited as separate HCS messages; relayer simulation denials never cost an on-chain transaction. | §53: a reverted EVM tx cannot persist its own HCS side effect. |
| D13 | 2026-10-03 | Sponsor only sponsors accounts deployed by its factory with salt 0. | Prevents the sponsor paying for arbitrary contracts. |
| D14 | 2026-10-03 | `vitest@3.2.7` (not 5.x). | vitest 5 requires Node ≥22.12; the template promises Node ≥20.18.3. |
| D15 | 2026-10-03 | Dependencies: `viem@2.39.0` (same as template frontend), `zod@4.6.5` (wire/env schemas), `tsx@4.23.15` (run TS scripts), `dotenv@18.0.5` (load `.env` in scripts). | Each pinned to a version checked on npm 2026-10-03. |
| D16 | 2026-10-03 | Demo swap pair WHBAR → USDC(0.0.5449) on the 0.30% pool; the account wraps HBAR via `WHBAR.deposit()`. | Live liquidity verified; avoids depending on faucet tokens. |
| D17 | 2026-10-03 | Agent guidance lives only in AGENTS.md; no tool-specific instruction files. | Owner requirement. |
| D18 | 2026-10-03 | Session USD caps priced by `SupraPriceOracle` over Supra push feeds (HBAR_USD 432, USDC_USD 89, max age 2 h, round up). | Pyth testnet prices were stale and Hermes now requires an API key; Supra feeds are pushed by Supra. |
| D19 | 2026-10-03 | x402 `transferExecutor` implemented in this template on `@x402/core` (facilitator + client); payTo resolves to the account's EVM alias. | `@x402/hedera@2.28.0` lacks the method; HBAR to an aliased account's long-zero address fails from a contract. |
| D20 | 2026-10-03 | Recurring payments reschedule themselves through HSS; execution is permissionless but inert; 2M gas per instalment, scheduled 10 s after due. | No keeper needed; measured HSS cost and block-timestamp lag. |
| D21 | 2026-10-04 | Vault and launchpad are standalone contracts; the account only gains `vault-deposit` and the share-transfer guard. | Factory is 341 bytes under the 24 KB limit (it embeds the account's creation code); a clone-based factory is the path for further account features. |
| D22 | 2026-10-04 | Airdrop fees outside session caps are documented, not fixed on-chain. | Fix needs account bytecode the factory margin cannot hold; the app never grants `airdrop` to agents. |
| D23 | 2026-10-04 | Sponsor requests may carry `minGas` (capped, budget-priced). | HTS association / airdrop fees are charged as gas and `eth_estimateGas` does not model them. |
