# Architecture

```
Human (controller key, 0 HBAR) ─┐                       ┌─ payment / airdrop / swap-to-pay / vault-deposit
AI agent (session key) ─────────┼─ signs EIP-712 ─▶ relayer ─▶ ConsumerAccount ─┼─ x402 executeTransfer
MCP server (holds session key) ─┘   (pays the fee)   (policy)   └─ action modules (launchpad-buy, yours)
                                         │                 │
                                   Mirror Node verify   HCS audit (allow + deny)
```

| Package | Role |
| --- | --- |
| `packages/foundry` | ConsumerAccount, factory, oracle, vault, launchpad, action modules, tests (unit, fuzz, invariant) |
| `packages/sdk` | Framework-independent TypeScript: intents, typed actions, payment requests, receipts, Mirror client, x402 client, ABIs |
| `packages/relayer` | Sponsor pipeline, HCS auditor, x402 transferExecutor facilitator, standalone HTTP server |
| `packages/mcp` | MCP server for agents |
| `packages/nextjs` | Consumer app and API routes (`/api/sponsor`, `/api/agent`, `/api/x402/*`, `/api/faucet`) |
| `scripts` | `doctor`, `bootstrap`, `prove:testnet`, `sponsor:fund`, `new:action`, `check:scaffold` |

## Two enforcement layers

1. **Relayer (sponsor policy)** decides whether to spend *sponsor* HBAR: schema validation, chain ID, expiry,
   deduplication, daily and per-account budgets, rate limits, simulation, factory membership. It has no authority
   over user funds: every request carries the user's or agent's signature, and the account verifies it.
2. **ConsumerAccount (account policy)** decides whether *user* funds may move: signatures, nonces, expiry, session
   permissions, recipients, USD caps, fee accounting, reserved IDs.

A compromised relayer can refuse service or waste sponsor HBAR; it cannot sign for a user. A compromised session
key can spend at most its caps on its allowed actions and recipients until it expires or is revoked.

## Request flow

1. The app (or SDK user, or MCP server) builds an owner intent or a typed session action and signs it.
2. `POST /api/sponsor` (or the standalone relayer `POST /v1/sponsor`) validates, budgets and simulates it.
3. The relayer submits it, paying gas; the account verifies and executes.
4. The relayer verifies the result on Mirror Node, writes an HCS audit record (allows and denials), returns a receipt.
