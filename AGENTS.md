# Agent instructions

Briefing for coding agents working in this repository.

Scaffold-HBAR Consumer: programmable ConsumerAccounts with sponsored execution, payments, HIP-904 delivery, SaucerSwap swap-to-pay and policy-constrained agent sessions, on Hedera testnet. Yarn workspaces, Foundry only, Next.js App Router.

## Layout

| Path | What |
| --- | --- |
| `packages/foundry/contracts` | `ConsumerAccount.sol`, `ConsumerAccountFactory.sol`, `Actions.sol`, `interfaces/` |
| `packages/foundry/test` | Foundry tests; `test/mocks/Mocks.sol` holds test-only `Mock*` contracts |
| `packages/sdk/src` | Framework-independent SDK. `abi.ts` is generated (`yarn sdk:abis`) — never edit by hand |
| `packages/sdk/deployments/testnet.json` | Public deployment artifact written by `yarn bootstrap` |
| `packages/relayer/src` | `Sponsor` pipeline, HCS auditor, standalone server |
| `packages/nextjs` | Consumer app; API routes in `app/api/{sponsor,agent}` reuse `@sh/relayer` |
| `scripts` | `doctor.ts`, `bootstrap.ts`, `prove-testnet.ts` |
| `docs` | Build state, decisions, sources, open questions, interfaces, invariants, gotchas |

## Commands

```bash
yarn doctor                 # environment + live testnet checks
yarn bootstrap [--fund]     # dry run, or create accounts / deploy / create topic
yarn prove:testnet          # testnet evidence → TESTNET_VERIFICATION.md
yarn start                  # frontend dev server
yarn test                   # contracts + SDK + relayer
yarn redteam                # policy/red-team Foundry suites
yarn lint && yarn typecheck && yarn build
yarn sdk:abis               # after changing contracts
```

## Invariants (do not weaken)

1. Session keys never get raw `target + value + calldata` authority.
2. Admin functions are `onlySelf`; sessions cannot reach them.
3. Every signature binds chain, account, nonce and expiry; nonces are single-use.
4. Unpriceable session spend fails closed (`PriceUnavailable`).
5. Every HTS response code is checked; raw owner calls to `0x167` are forbidden.
6. The sponsor/relayer never gains authority over user funds.

Full list with tests: `docs/SECURITY_INVARIANTS.md`.

## Adding a typed action

1. Add a stable ID to `Actions.sol` and the same preimage to `sdk/src/actions.ts` (`ACTION_IDS`).
2. Define the `actionData` encoding (struct or tuple) and an SDK encoder/decoder with a round-trip test.
3. Handle it in `ConsumerAccount.executeSessionAction`: decode, check targets against an owner-managed allowlist, price the worst-case spend with `_chargeSession`, execute, verify the outcome.
4. Foundry tests: allowed path, each denial reason, owner path.
5. Teach `packages/relayer/src/sponsor.ts` to summarise it for receipts/audit.
6. Regenerate ABIs (`yarn sdk:abis`) and update `docs/CONTRACT_INTERFACES.md`.

## Prohibited shortcuts

- No mocks in `scripts/prove-testnet.ts`, `TESTNET_VERIFICATION.md` or UI success states.
- No invented addresses, token IDs, ABIs or package versions — verify and record in `docs/SOURCES.md`.
- No silent fallbacks: integration failures return typed errors (`SAUCERSWAP_QUOTE_UNAVAILABLE`, `HCS_AUDIT_FAILED`, …).
- Never commit `.env` or put secrets in `NEXT_PUBLIC_*`.

## Hedera pitfalls

See `docs/HEDERA_GOTCHAS.md`: tinybars inside the EVM vs weibars over JSON-RPC, token association, WHBAR, long-zero vs alias addresses, Mirror Node lag, no system contracts on Anvil.

## Frontend notes

- `types/abitype/abi.d.ts` registers viem's `Address` as `string` app-wide; SDK serialisers accept plain strings for that reason.
- The browser controller key (`services/consumer/controller.ts`) is a testnet adapter, not production custody.
- Use DaisyUI components; prefer consumer copy ("Pay", "Fees sponsored") and keep protocol detail on the Developer page.
