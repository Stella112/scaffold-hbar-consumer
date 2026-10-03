# Scaffold-HBAR Consumer

**A Scaffold-HBAR template for programmable Hedera accounts: users pay with zero HBAR (a sponsor covers fees), request money by QR/link, swap-to-pay through SaucerSwap, deliver tokens to unassociated recipients with HIP-904, and give AI agents spending allowances that the account enforces on-chain — with every policy decision audited to HCS.**

```bash
npx create-scaffold-hbar@latest --template Stella112/scaffold-hbar-consumer
```

**Live demo (Hedera testnet):** https://hbar.38-49-209-149.sslip.io

> Testnet software. Unaudited. Do not use with mainnet funds.

---

## Testnet evidence

`yarn prove:testnet` runs the core flows against Hedera testnet through the real sponsor relayer and writes [`TESTNET_VERIFICATION.md`](TESTNET_VERIFICATION.md) from observed results only (transaction IDs, HashScan links, Mirror Node queries, HCS sequence numbers).

| Flow | What it proves |
| --- | --- |
| 1 | A ConsumerAccount is created by the sponsor for a controller key that has no Hedera account |
| 2 | **Zero-HBAR controller**: controller signs, sponsor pays the fee, merchant receives HBAR from the account |
| 3 | Direct HTS token payment (WHBAR) |
| 4 | **SaucerSwap swap-to-pay**: account holds WHBAR, merchant receives *exactly* the requested USDC |
| 5 | **HIP-904**: token sent to an intentionally unassociated recipient lands as a pending airdrop |
| 8 | Agent red team: withdraw / escalate / unknown action / wrong recipient are denied with reason codes and HCS records |
| 9 | Raw-call bypass: denied by the relayer *and* reverted on-chain when submitted directly, with a correlated HCS denial |

All flows above pass in the committed [`TESTNET_VERIFICATION.md`](TESTNET_VERIFICATION.md) (run 2026-10-03). Nothing in it is hand-written.

Reference testnet deployment: ConsumerAccountFactory [0.0.10841522](https://hashscan.io/testnet/contract/0.0.10841522), HCS audit topic [0.0.10841526](https://hashscan.io/testnet/topic/0.0.10841526), sponsor [0.0.10841387](https://hashscan.io/testnet/account/0.0.10841387).

## Quickstart

Requirements: Node ≥ 20.18.3, Yarn (Corepack or `npm i -g yarn`), Git, [Foundry](https://getfoundry.sh).

```bash
npx create-scaffold-hbar@latest --template Stella112/scaffold-hbar-consumer my-app
cd my-app
cp .env.example .env          # add HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY (ECDSA, from portal.hedera.com)
yarn doctor                   # PASS/WARN/FAIL checks against live testnet
yarn bootstrap                # prints the plan; nothing is sent
yarn bootstrap --fund         # creates sponsor/merchant/recipient accounts, deploys the factory, creates the HCS topic
yarn start                    # http://localhost:3000
yarn prove:testnet            # writes TESTNET_VERIFICATION.md
```

## Architecture

```
controller (0 HBAR) ──signs EIP-712──▶ sponsor relayer ──pays fee──▶ ConsumerAccount ──▶ HBAR / HTS / SaucerSwap / HIP-904
agent session key  ──signs typed action─┘     │  validate · dedupe · budget · simulate        │  owner: raw calls
                                              │  Mirror Node verify · receipt                  │  session: typed actions + policy
                                              └──────────── HCS audit (allow + deny) ◀─────────┘
```

| Package | Role |
| --- | --- |
| `packages/foundry` | `ConsumerAccount`, `ConsumerAccountFactory`, typed `Actions`, interfaces, 60 Foundry tests |
| `packages/sdk` | Framework-independent TypeScript: EIP-712 intents, typed action codecs, payment requests, reason codes, Mirror client, receipts, generated ABIs |
| `packages/relayer` | Sponsor pipeline (`Sponsor` class) + standalone HTTP server + HCS auditor |
| `packages/nextjs` | Consumer app: Home, Pay, Request, Activity, Agent, Sponsor, Developer; API routes reuse `@sh/relayer` |
| `scripts` | `doctor`, `bootstrap`, `prove:testnet` |

Two layers of enforcement: the **relayer** protects the sponsor's HBAR (budgets, rate limits, simulation); the **account contract** protects user assets (signatures, nonces, expiry, session policy). A compromised relayer cannot authorize anything; a compromised session cannot widen its own authority.

## Human payment flow

1. **Request**: the recipient signs a canonical request (recipient, asset, amount, memo, expiry, reference) → QR + link. Editing any field breaks the signature.
2. **Pay**: the payer's app verifies the request, then picks a route:
   - holds the asset and the recipient is associated → typed `payment`;
   - recipient not associated → typed `airdrop` (HIP-904 pending/claimable), decided from Mirror Node state;
   - doesn't hold the asset → `swap-to-pay`: live QuoterV2 exact-output quote, 2% max slippage, exact amount delivered or the whole action reverts.
3. **Receipt**: typed receipt with transaction ID, Mirror Node verification and HCS audit reference.

## Agent flow

The owner grants a session key a typed allowance: allowed actions, USD per-call and daily caps, optional recipient allowlist, expiry. The session can only call `executeSessionAction` with a registered action ID; it never gets raw `target + value + calldata`. A session signature on an owner intent reverts with `RawCallForbidden` before any external call.

## Red-team flow

| Attack | Result |
| --- | --- |
| Agent withdraws vault assets | `WITHDRAW_FORBIDDEN` |
| Agent exceeds caps | `PER_CALL_CAP_EXCEEDED` / `DAILY_CAP_EXCEEDED` |
| Agent uses an unknown/unallowed action or router | `ACTION_NOT_ALLOWED` / `TARGET_NOT_ALLOWED` |
| Agent submits a raw call | `RAW_CALL_FORBIDDEN` |
| Agent changes owner / guardians / sessions | `PRIVILEGE_ESCALATION` (or `NotSelf` on direct calls) |
| Agent spends with no trusted price | `PRICE_UNAVAILABLE` (fail closed) |

Try them in the app (**Agent → Try the scripted demo agent**). The demo agent is scripted, not an LLM.

## Hedera services used

- **Smart Contract Service**: ConsumerAccount + CREATE2 factory (Cancun EVM, chain 296).
- **HTS**: token payments through the ERC-20 facade; `associateToken` with checked response codes.
- **HIP-904**: `airdropTokens` for unassociated recipients.
- **HCS**: policy audit topic (sponsor-only submit key) recording allows and denials.
- **Mirror Node**: independent verification of every sponsored transaction, association checks, pending airdrops, audit feed.
- **HSS (HIP-1215)**: interface verified; recurring payments not yet implemented.

## External integrations

- **SaucerSwap V2** (load-bearing): exact-output swap-to-pay via SwapRouter 0.0.1414040 and QuoterV2 0.0.1390002; live pools and quotes in [`docs/SOURCES.md`](docs/SOURCES.md).
- **x402**: ConsumerAccount implements the spec's `ITransferExecutor` (`executeTransfer`, selector `0xea8f19fd`). The published `@x402/hedera@2.28.0` does not implement the `transferExecutor` method yet, so end-to-end x402 is **BLOCKED_EXTERNAL** (see [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md)).
- **USD oracle**: session caps go through `IPriceOracle`. No oracle is configured by default, so session spend fails closed.

## Configuration

All variables are documented in [`.env.example`](.env.example). Only `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` are required; `yarn bootstrap` generates the rest locally. Public deployment data (factory, topic, token IDs) goes to `packages/sdk/deployments/testnet.json`, never into secrets.

## Commands

| Command | Does |
| --- | --- |
| `yarn doctor` | toolchain, env, RPC, Mirror, balances, factory, topic, SaucerSwap quote, oracle/x402 status |
| `yarn bootstrap [--fund]` | plan (dry run) or create accounts, deploy factory, create HCS topic, write deployment artifact |
| `yarn prove:testnet` | run flows on testnet and write `TESTNET_VERIFICATION.md` |
| `yarn start` | Next.js dev server |
| `yarn next:build` / `yarn next:lint` / `yarn next:check-types` | frontend build, lint, types |
| `yarn foundry:test` / `yarn foundry:compile` / `yarn foundry:deploy` | contracts |
| `yarn sdk:test` / `yarn relayer:test` | TypeScript unit + Anvil end-to-end tests |
| `yarn sdk:abis` | regenerate SDK ABIs from Foundry output |
| `yarn relayer:start` | standalone sponsor relayer on `RELAYER_PORT` |

## Testing

- `packages/foundry/test`: owner intents (replay, tampering, wrong chain/account, expiry), session policy (every reason code), x402 executor binding, recovery, factory, swap-to-pay (under-delivery, overspend, path, router allowlist). Mocks are test-only and named `Mock*`.
- `packages/sdk/test`, `packages/relayer/test`: unit tests plus Anvil end-to-end runs against the compiled contracts (skipped if `anvil` is not installed). Local runs are never used as testnet evidence.

## Security

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY_INVARIANTS.md`](docs/SECURITY_INVARIANTS.md) (each invariant mapped to tests).

## Extending

Add a typed action by giving it a stable ID in `Actions.sol` and `sdk/src/actions.ts`, a decoder and handler branch in `ConsumerAccount.executeSessionAction`, policy pricing (asset + worst-case amount), tests for allowed and denied paths, and a relayer summary. See [`AGENTS.md`](AGENTS.md).

## Limitations

- Testnet only; contracts are unaudited.
- No price oracle configured → agent spending is always denied until one is verified and set.
- x402 end-to-end is blocked on facilitator support for `transferExecutor`.
- Recurring payments (HSS), vault and launchpad recipes are not built.
- The browser controller key is a testnet convenience stored in localStorage, not production custody.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `operator key does not match … EVM alias` | Use the ECDSA key of an account created with an EVM alias. |
| `SPONSOR_NOT_CONFIGURED` in the app | Fill `.env` (sponsor id/key) and restart `yarn start`. |
| Mirror verification `pending` | Mirror Node lags a few seconds; the receipt links to HashScan meanwhile. |
| Swap shows `SAUCERSWAP_QUOTE_UNAVAILABLE` | Testnet pool liquidity changed; `yarn doctor` shows the current quote. |
| Payment to a token recipient fails | Recipient isn't associated: the app routes it as a HIP-904 airdrop instead. |

## License

MIT — see [LICENCE](LICENCE). Based on [hedera-dev/scaffold-hbar](https://github.com/hedera-dev/scaffold-hbar).
