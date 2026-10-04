# Scaffold-HBAR Consumer

**A Scaffold-HBAR template for programmable Hedera accounts: users pay with zero HBAR (a sponsor covers fees), request money by QR/link, swap-to-pay through SaucerSwap, deliver tokens to unassociated recipients with HIP-904, schedule recurring payments with the Hedera Schedule Service, save in an agent-safe vault, launch fixed-supply HTS tokens, and give AI agents USD-capped allowances (priced live by Supra) that the account enforces on-chain — usable over x402 and MCP, with every policy decision audited to HCS.**

```bash
npx create-scaffold-hbar@latest --template Stella112/scaffold-hbar-consumer
```

**Live demo (Hedera testnet):** https://hbar.getqueryflow.xyz

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
| 6 | **x402** `exact` / `transferExecutor`: an agent session pays a 402 resource; replay and amount tampering are rejected |
| 7 | **AI agent via MCP** against the deployed app: allowance, sponsored payment, cap denial returned to the model, x402 purchase |
| 8 | Agent pays within live **Supra**-priced USD caps; over-cap, withdraw, escalate, unknown action and wrong recipient are denied with reason codes and HCS records |
| 9 | Raw-call bypass: denied by the relayer *and* reverted on-chain when submitted directly, with a correlated HCS denial |
| 10 | **Recurring payment** created once by the owner and executed twice by the **Hedera Schedule Service** with no further transactions |
| 11 | **Savings vault**: an agent deposits within its caps; paying the vault shares away or withdrawing is denied; the owner redeems |
| 12 | **Token launchpad**: an immutable fixed-supply HTS token on a bonding curve, bought to target, graduates exactly once into a **SaucerSwap V1 pool** (second call `AlreadyGraduated`), claims arrive by HIP-904 airdrop |
| 14 | **HIP-904 claim**: a fresh account with no association slots receives a pending airdrop and claims it itself through HTS `claimAirdrops` (the Claim page's path) |
| 15 | **Guardian recovery**: two guardian accounts (no HBAR, sponsored), threshold 2, 5-minute timelock; early execution reverts `RecoveryNotReady`; afterwards the old key is rejected and the new key pays |
| 13 | **Agent fee caps**: a HIP-904 airdrop's HBAR fee is charged to the agent's USD caps (`SessionFeeCharged`); an airdrop whose fee alone exceeds the cap is denied `PER_CALL_CAP_EXCEEDED` |

Results are in the committed [`TESTNET_VERIFICATION.md`](TESTNET_VERIFICATION.md). Nothing in it is hand-written.

Reference testnet deployment (source-verified on Sourcify): ConsumerAccountFactory [0.0.10853888](https://hashscan.io/testnet/contract/0.0.10853888), SupraPriceOracle [0.0.10844780](https://hashscan.io/testnet/contract/0.0.10844780), SavingsVault [0.0.10848627](https://hashscan.io/testnet/contract/0.0.10848627), TokenLaunchpad [0.0.10848836](https://hashscan.io/testnet/contract/0.0.10848836), HCS audit topic [0.0.10841526](https://hashscan.io/testnet/topic/0.0.10841526), sponsor [0.0.10841387](https://hashscan.io/testnet/account/0.0.10841387).

## Documentation

Topic guides live in [`docs/guides`](docs/guides/README.md): architecture, account model, sponsorship, policy and agents, payments, x402, MCP, recovery, scheduling, vault, launchpad, custom actions and testnet proof.

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
| `packages/foundry` | `ConsumerAccount` (+ HSS subscriptions, vault deposits, session fee caps), `ConsumerAccountFactory` (account code in SSTORE2 chunks), `SupraPriceOracle`, `SavingsVault`, `TokenLaunchpad`, typed `Actions`, 124 Foundry tests |
| `packages/sdk` | Framework-independent TypeScript: EIP-712 intents, typed action codecs, payment requests, reason codes, Mirror client, receipts, generated ABIs |
| `packages/relayer` | Sponsor pipeline (`Sponsor`), x402 `TransferExecutorFacilitator`, standalone HTTP server, HCS auditor |
| `packages/mcp` | MCP server for AI agents: 10 tools (balance, policy, sponsor, payment, payment request, swap-and-pay, x402, vault deposit, receipt, audit log) |
| `packages/nextjs` | Consumer app: Home, Pay (paste or scan QR), Request, Recurring, Save, Launch, Claim, Recovery, Activity, Agent, Sponsor, Developer; sponsor, x402 and faucet API routes |
| `scripts` | `doctor`, `bootstrap`, `prove:testnet`, `sponsor:fund`, `new:action`, `check:scaffold` |

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

Try them in the app (**Agent → Try the scripted demo agent**). The demo agent is scripted, not an LLM; for a real model, use the MCP server below.

## AI agents (MCP)

`packages/mcp` is an MCP server holding only the agent's **session key**. Every spend is a typed session action the account checks on-chain; denials return their reason code to the model.

```json
{
  "mcpServers": {
    "consumer-account": {
      "command": "yarn",
      "args": ["--cwd", "/path/to/my-app", "mcp:start"],
      "env": {
        "CONSUMER_ACCOUNT": "0xYourConsumerAccount",
        "AGENT_PRIVATE_KEY": "0xSessionKeyGrantedOnTheAgentPage",
        "CONSUMER_APP_URL": "http://localhost:3000"
      }
    }
  }
}
```

Tools: `get_balance`, `get_policy` (caps, spent today, expiry, live HBAR/USD), `get_sponsor_status`, `create_payment` (HBAR/USDC/WHBAR to `0.0.x` or `0x…`, sponsored), `create_payment_request` (signed link for someone to pay the account), `swap_and_pay` (SaucerSwap exact-output), `purchase_x402` (x402 over HTTP, client-side HBAR cap), `deposit_vault`, `get_receipt` (Mirror Node), `get_audit_log` (HCS). There is no arbitrary-call tool: MCP describes what the agent may request; the account decides what executes.

## x402

`/api/x402/premium` is a paid resource (0.05 HBAR, live HBAR/USD data). Without `PAYMENT-SIGNATURE` it answers **402** with `PAYMENT-REQUIRED`; with a valid payment it settles and returns the data plus `PAYMENT-RESPONSE`. The app is also a facilitator for `exact` / `transferExecutor` on `hedera:testnet` (`/api/x402/facilitator/{supported,verify,settle}`), implementing `scheme_exact_hedera.md`: executor admission (factory-deployed ConsumerAccounts), calldata built only from the requirements, capped-gas simulation, `ContractExecuteTransaction` settlement and parent + child record conformance. Clients use `TransferExecutorClient` with `@x402/core`'s `x402Client`.

## Custom actions

`yarn new:action <name>` scaffolds a new typed action as an owner-installed **action module**: a read-only planner the account calls, after which the account itself charges the declared spend against the session's caps and recipients, executes the calls (never to itself or HTS) and verifies the outflow. The generator writes the module, Foundry tests, an SDK encoder with a round-trip test and a docs page; CI checks that generated code passes its tests and `forge fmt` unchanged. See [`docs/guides/custom-actions.md`](docs/guides/custom-actions.md).

## Recurring payments

**Recurring** creates an HBAR payment plan. The account schedules each instalment with the **Hedera Schedule Service** (`scheduleCall` on `0x16b`, HIP-1215); each execution pays the configured recipient and schedules the next — no server or keeper. Execution is permissionless but inert (only the owner-configured payment, only when due); creation and cancellation are owner-only. Scheduled transactions are paid by the account (~2M gas, about 1.5–1.7 testnet HBAR per instalment, because HSS `scheduleCall` itself costs ~1.54M gas), so it needs some HBAR.

## Savings vault (recipe)

`SavingsVault` is an OpenZeppelin ERC-4626 vault over an HTS token (WHBAR in the reference deployment), with a decimals offset of 9 against first-depositor inflation and a constructor that associates the vault with the token. **Save** deposits and withdraws. Agents can be granted the typed `vault-deposit` action: deposits go only to owner-allowlisted vaults, count against the session's USD caps, use an exact approval that is reset, and always mint shares to the account. Agents can never withdraw (`vault-withdraw` / `vault-redeem` are reserved → `WITHDRAW_FORBIDDEN`), and the shares of any vault ever allowed are untransferable for sessions through every action, so "paying" the shares away is also a withdrawal and is denied.

## Token launchpad (recipe)

`TokenLaunchpad` creates an HTS token through the Token Service with **no admin, supply, freeze, wipe or pause keys** and a finite supply, and sells it along a **linear bonding curve** (start → end price, exact integral, rounded up). At the target anyone can `graduate` **exactly once**: the creator gets a capped fee (≤ 10%), and the rest of the raise plus reserved tokens seed a **SaucerSwap V1 HBAR/token pool** at the curve's final price (`addLiquidityETHNewPool`; the ~$2 pool fee is converted through the 0x168 exchange-rate precompile). LP tokens stay locked in the launchpad. A front-run pool gets liquidity added instead. Buyers and the creator `claim` by HIP-904 airdrop; a missed deadline opens refunds. Agents buy through the `launchpad-buy` action module within their USD caps.

## Hedera services used

- **Smart Contract Service**: ConsumerAccount + CREATE2 factory (Cancun EVM, chain 296).
- **HTS**: token payments through the ERC-20 facade; `associateToken` with checked response codes.
- **HIP-904**: `airdropTokens` for unassociated recipients.
- **HCS**: policy audit topic (sponsor-only submit key) recording allows and denials.
- **Mirror Node**: independent verification of every sponsored transaction, association checks, pending airdrops, audit feed.
- **HSS (HIP-1215)**: recurring payments scheduled and executed by the network.

## External integrations

- **SaucerSwap V2** (load-bearing): exact-output swap-to-pay via SwapRouter 0.0.1414040 and QuoterV2 0.0.1390002; live pools and quotes in [`docs/SOURCES.md`](docs/SOURCES.md).
- **x402** (`@x402/core` 2.28.0): ConsumerAccount implements `ITransferExecutor`; this template ships the `transferExecutor` facilitator and client, since `@x402/hedera@2.28.0` only implements `cryptoTransfer`.
- **Supra** push oracle (testnet `0x6Cd59830…b917`, HBAR_USD #432, USDC_USD #89) behind `SupraPriceOracle`: stale (> 2 h), future, zero or unsupported prices fail closed; values round up.
- **MCP** (`@modelcontextprotocol/sdk` 1.32.0): agent tool server.

## Configuration

All variables are documented in [`.env.example`](.env.example). Only `HEDERA_OPERATOR_ID` and `HEDERA_OPERATOR_KEY` are required; `yarn bootstrap` generates the rest locally. Public deployment data (factory, topic, token IDs) goes to `packages/sdk/deployments/testnet.json`, never into secrets.

## Commands

| Command | Does |
| --- | --- |
| `yarn doctor` | toolchain, env, RPC, Mirror, balances, factory, topic, SaucerSwap quote, oracle/x402 status |
| `yarn bootstrap [--fund]` | plan (dry run) or create accounts, deploy factory, create HCS topic, write deployment artifact |
| `yarn prove:testnet` | run flows on testnet and write `TESTNET_VERIFICATION.md` |
| `yarn new:action <name>` | scaffold a custom typed action (module, tests, SDK encoder, docs) |
| `yarn sponsor:fund [HBAR] [--fund]` | top up the sponsor from the operator (dry run without `--fund`) |
| `yarn mcp:start` | MCP server for an agent (see above) |
| `yarn check:scaffold` | fresh `create-scaffold-hbar` scaffold → install, typecheck, lint, test, build, boot |
| `yarn start` | Next.js dev server |
| `yarn next:build` / `yarn next:lint` / `yarn next:check-types` | frontend build, lint, types |
| `yarn foundry:test` / `yarn foundry:compile` / `yarn foundry:deploy` | contracts |
| `yarn test` | contracts + SDK + relayer + MCP tests |
| `yarn sdk:abis` | regenerate SDK ABIs from Foundry output |
| `yarn relayer:start` | standalone sponsor relayer on `RELAYER_PORT` |

## Testing

- `packages/foundry/test`: owner intents (replay, tampering, wrong chain/account, expiry), session policy (every reason code), x402 executor binding, recovery, factory, swap-to-pay, Supra oracle (staleness, future, zero, revert, rounding fuzz), HSS subscriptions. Mocks are test-only and named `Mock*`.
- `packages/sdk/test`, `packages/relayer/test`, `packages/mcp/test`: unit tests, x402 settlement-record conformance, MCP tools over an in-memory transport, plus Anvil end-to-end runs. Local runs are never used as testnet evidence.

## Security

See [`SECURITY.md`](SECURITY.md) and [`docs/SECURITY_INVARIANTS.md`](docs/SECURITY_INVARIANTS.md) (each invariant mapped to tests).

## Extending

Add a typed action by giving it a stable ID in `Actions.sol` and `sdk/src/actions.ts`, a decoder and handler branch in `ConsumerAccount.executeSessionAction`, policy pricing (asset + worst-case amount), tests for allowed and denied paths, and a relayer summary. See [`AGENTS.md`](AGENTS.md).

## Limitations

- Testnet only; contracts are unaudited.
- Supra testnet feeds update hourly (or on a 5% move); if a feed goes stale for over 2 hours, agent spending is denied until it updates.
- x402 here settles through ConsumerAccounts (`transferExecutor`); `cryptoTransfer` payers use `@x402/hedera` directly.
- Recurring payments are HBAR-only in the UI (the contract also supports HTS tokens).
- The savings vault has no yield strategy. Every candidate yield source on testnet was checked and is unusable: Bonzo Lend testnet rejects deposits (`CALLER_NOT_AUTHORIZED`), the SaucerSwap V1 WHBAR/USDC pool has had no trades since Dec 2024, and HBARX has no testnet deployment ([`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) U15). We do not fabricate yield.
- The browser controller key is a testnet convenience stored in localStorage, not production custody.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `operator key does not match … EVM alias` | Use the ECDSA key of an account created with an EVM alias. |
| `SPONSOR_NOT_CONFIGURED` in the app | Fill `.env` (sponsor id/key) and restart `yarn start`. |
| Mirror verification `pending` | Mirror Node lags a few seconds; the receipt links to HashScan meanwhile. |
| Swap shows `SAUCERSWAP_QUOTE_UNAVAILABLE` | Testnet pool liquidity changed; `yarn doctor` shows the current quote. |
| Payment to a token recipient fails | Recipient isn't associated: the app routes it as a HIP-904 airdrop instead. |
| `SPONSOR_BUDGET_EXCEEDED` / `SPONSOR_USER_BUDGET_EXCEEDED` | Daily sponsor policy reached; raise the limits in `.env` or wait for the UTC day to roll. |
| Sponsored calls fail with insufficient funds | `yarn doctor` shows the sponsor balance; `yarn sponsor:fund 100 --fund`. |
| HBAR to a `0x000…` address fails from a contract | Use the account's EVM alias; see [`docs/HEDERA_GOTCHAS.md`](docs/HEDERA_GOTCHAS.md). |
| Launchpad claim reverts `HtsCallFailed(10)` | Send HBAR with the claim for its airdrop fee (the app sends 2 HBAR; the rest is refunded). |
| An intent that associates a token then transfers runs out of gas | HTS fees are charged as gas and not estimated; pass `minGas` with the sponsor request (the app uses 2.5M). |

## License

MIT — see [LICENCE](LICENCE). Based on [hedera-dev/scaffold-hbar](https://github.com/hedera-dev/scaffold-hbar).
