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
| D24 | 2026-10-04 | Factory deploys EIP-1167 clones of one ConsumerAccount implementation (initialize in the same call, implementation initializers disabled). Supersedes the size constraint in D21. | The factory embedded the account's creation code and sat 341 bytes under 24 KB; now ~1 KB. |
| D25 | 2026-10-04 | Unexpected HBAR outflow during session actions (network fees) is priced and charged to the session caps. Supersedes D22. | Contract-initiated HIP-904 fees are charged to the account; caps must cover every HBAR an agent can make the account spend. |
| D26 | 2026-10-04 | Relayer decodes on-chain revert reasons via Mirror Node. | Receipts carry no revert data; fee-cap denials happen on chain. |
| D27 | 2026-10-04 | Accounts are full contracts again; their creation code lives in SSTORE2 data chunks the factory reassembles. Supersedes the clone design in D24 (factory stays ~1.4 KB). | Testnet: HSS scheduled payments from a clone failed `INVALID_PAYER_SIGNATURE` — Hedera does not activate a contract key for delegatecall code. |
| D28 | 2026-10-04 | Custom typed actions are owner-installed planner modules (`IActionModule`); the account keeps every policy check and executes the calls itself. `yarn new:action` scaffolds them. | Lets builders add actions without touching ConsumerAccount; the clearest proof the template is reusable. |
| D29 | 2026-10-04 | Contracts compile with via-IR. | ConsumerAccount was 229 B over EIP-170 after modules; via-IR gives a 2.1 KB margin. |
| D30 | 2026-10-04 | Launchpad v2: linear bonding curve, graduation into a SaucerSwap V1 pool with locked LP, capped creator fee. | Spec §29; V1's addLiquidityETHNewPool creates and seeds an HBAR/token pool in one call (~$2 fee, ~8.3M gas from a contract). |
| D31 | 2026-10-04 | Factory `isAccount` registry replaces CREATE2 re-derivation for sponsorship, x402 admission and the faucet. | Testnet flow 15: after recovery the owner changes, so the address can no longer be re-derived. |
| D32 | 2026-10-04 | Payment requests may be signed by a live session key of the recipient account. | Lets agents (MCP `create_payment_request`) ask for money; requesting moves no funds. |
| D33 | 2026-10-04 | Vault yield strategy not shipped (U15). | No working yield source on testnet; fabricated yield is prohibited. |
