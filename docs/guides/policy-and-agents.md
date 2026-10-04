# Policy and agents

## Sessions

`grantSession({ key, expiresAt, perCallCapUsd6, dailyCapUsd6, allowedActions, allowedRecipients })` (owner only).
A session can only call `executeSessionAction` with an allowed typed action or sign x402 transfers if it has
`x402-payment`. It never gets raw calls (`RAW_CALL_FORBIDDEN` before any external call). Reserved IDs
(`consumer.admin.*`, `vault-withdraw`, `vault-redeem`) answer `PRIVILEGE_ESCALATION` / `WITHDRAW_FORBIDDEN` and
cannot even be granted. Sessions end at expiry, on `revokeSession`, or when the owner changes (recovery).

## Typed actions

| ID (`consumer.action.*.v1`) | Agent can |
| --- | --- |
| `payment` | send HBAR or a token to a recipient |
| `airdrop` | HIP-904 token delivery |
| `swap-to-pay` | SaucerSwap exact-output swap paid to a recipient, through an owner-allowlisted router |
| `x402-payment` | authorize an x402 transfer |
| `vault-deposit` | deposit into an owner-allowlisted vault (never withdraw) |
| `launchpad-buy` (module) | buy launch tokens at the quoted price |
| yours | see [custom-actions](custom-actions.md) |

## USD caps

Each session spend is valued by `IPriceOracle` and charged against `perCallCapUsd6` and `dailyCapUsd6`.
`SupraPriceOracle` reads Supra push feeds (HBAR_USD #432, USDC_USD #89) and returns `ok = false` for stale (> 2 h),
future, zero, absurd or unsupported prices; the account then denies with `PRICE_UNAVAILABLE`. Values round up.

Network fees the account itself pays during a session action (e.g. HIP-904 airdrop fees) are measured as the HBAR
balance change beyond the intended payment, priced, and charged to the same caps (`SessionFeeCharged`).

## Red team (tested on testnet, flows 8, 9, 11, 13)

| Attempt | Result |
| --- | --- |
| over the per-call / daily cap | `PER_CALL_CAP_EXCEEDED` / `DAILY_CAP_EXCEEDED` |
| non-allowlisted recipient | `RECIPIENT_NOT_ALLOWED` |
| unknown or ungranted action | `ACTION_NOT_ALLOWED` |
| unlisted router, vault or self-call by a module | `TARGET_NOT_ALLOWED` |
| raw call | `RAW_CALL_FORBIDDEN` (relayer and contract) |
| make itself owner / guardian, grant sessions | `PRIVILEGE_ESCALATION` |
| withdraw or move vault shares | `WITHDRAW_FORBIDDEN` |
| no trusted price | `PRICE_UNAVAILABLE` |

Every allow and deny is written to the HCS audit topic. Foundry invariant tests
(`test/invariant/SessionInvariants.t.sol`) drive random agent behaviour against these rules.
