# Payments

## Pay and request

**Request** creates a canonical EIP-712 payment request (recipient, asset, amount, memo, expiry, reference ID) as a
link and QR code. Any edit breaks the signature. Valid signers: the recipient, the recipient account's owner, or a
live session key of that account (so agents can request money; requesting moves nothing).

**Pay** opens a link, a pasted code, or a scanned QR (camera), verifies the request, then picks a route:

| Situation | Route |
| --- | --- |
| payer holds the asset, recipient can receive it | typed `payment` |
| recipient not associated with the token | typed `airdrop` (HIP-904) |
| payer lacks the asset | `swap-to-pay` via SaucerSwap |

The route is decided from Mirror Node state, never by catching a failed transfer.

## Swap-to-pay (SaucerSwap V2)

Live `QuoterV2.quoteExactOutputSingle`, 2% slippage bound (`amountInMaximum`), exact-output swap through the
owner-allowlisted SwapRouter (0.0.1414040). The account approves exactly `amountInMaximum`, resets the approval,
and reverts unless the recipient's balance grew by at least `amountOut` and no more than the maximum was spent.

## HIP-904 delivery and claims

ConsumerAccounts have unlimited auto-association, so tokens to them arrive directly. Tokens sent to an ordinary
account that is not associated and has no free slots become **pending airdrops**. The **Claim** page lists them
(Mirror Node) and the recipient claims with its own wallet through HTS `claimAirdrops` on `0x167`, which also
associates the token (testnet flow 14). A contract that airdrops pays the airdrop fee from its own HBAR; for
sessions that fee counts against the caps.

HBAR sent from a contract must go to the recipient's EVM alias, not its long-zero address
(`resolveX402PayTo` / `docs/HEDERA_GOTCHAS.md`).
