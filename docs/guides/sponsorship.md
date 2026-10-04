# Sponsorship

A controller key never needs HBAR. The relayer submits the user's signed request and pays the network fee; the
account pays only the amounts the user chose to move.

## Pipeline (`packages/relayer/src/sponsor.ts`)

parse (zod) → chain ID → expiry ≥ 30 s → deduplicate by signature → factory membership (`isAccount`) → gas
estimate (+30%, floors for HIP-904 airdrops and an optional `minGas` for intents with HTS work) → budget policy
(daily total, per account, rate) → submit → wait → decode any revert via Mirror Node → verify on Mirror Node →
HCS audit → receipt.

## Configuration (`.env`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPONSOR_DAILY_BUDGET_HBAR` | 50 | total sponsor spend per UTC day |
| `SPONSOR_PER_USER_DAILY_HBAR` | 10 | per account per day (account creation alone reserves ~4–6 HBAR of gas) |
| `SPONSOR_RATE_LIMIT_PER_MINUTE` | 20 | requests per account per minute |
| `FAUCET_HBAR` / `FAUCET_DAILY_HBAR` / `FAUCET_SPONSOR_RESERVE_HBAR` | 25 / 300 / 40 | one-time demo funding for new accounts |

`yarn sponsor:fund <HBAR> [--fund]` tops up the sponsor from the operator (dry run without `--fund`);
`yarn doctor` warns below 20 HBAR. The Sponsor page shows balance, runway, spend by action and denial reasons.

## Receipts

Every request returns a typed receipt (`packages/sdk/src/receipt.ts`): account, actor and actor type, action,
assets and amounts, recipient, sponsor, transaction hash and ID, consensus timestamp, network fee, Mirror Node
verification, HCS audit reference; denials carry a reason code and who denied (`sponsor-policy` or
`account-contract`).
