# Security

> **Testnet only. The contracts are unaudited.** Do not hold mainnet value in a ConsumerAccount.

Report vulnerabilities privately to the repository owner via a GitHub security advisory.

## Threat model

| Actor | Can | Cannot |
| --- | --- | --- |
| Owner (controller key) | Sign owner intents (raw calls), typed actions without caps, admin self-calls | Bypass nonce/expiry; call HTS `0x167` raw (must use checked helpers) |
| Session key (agent) | Sign registered typed actions within its policy; sign x402 transfer authorizations if granted | Raw calls, admin functions, privileged/withdrawal action IDs, raising its own limits, extending itself |
| Sponsor relayer | Choose whether to pay fees; submit signed requests | Create authority: the contract ignores `msg.sender` on execute paths |
| Guardian | Propose/approve recovery | Finalize before threshold + timelock; act when owner cancels |
| Factory | Deploy accounts | Hold any role in deployed accounts; claim another owner's address (owner is in the CREATE2 salt) |
| x402 facilitator | Call `executeTransfer` with a signed authorization | Change recipient, asset or amount (all bound by EIP-712); reuse an authorization |

## Owner / session separation

- `executeOwnerIntent` accepts only owner signatures. If the signer is an active session the call reverts `RawCallForbidden` **before any external call**.
- `executeSessionAction` dispatches only known typed actions (`payment`, `airdrop`, `swap-to-pay`). Reserved admin IDs revert `PrivilegeEscalation`, withdrawal IDs revert `WithdrawForbidden`.
- Admin functions are `onlySelf`; the only way in is an owner-signed self-call.
- Owner rotation (directly or by recovery) increments `ownerEpoch`, which kills every existing session.

## Replay protection

Every signature is EIP-712 bound to `chainId`, the verifying account, a random 256-bit single-use nonce and an expiry. Tampering with any field changes the recovered signer. Nonces are consumed only when execution succeeds (a revert rolls the nonce back).

## Sponsor trust assumptions

The sponsor pays fees only. Off-chain policy (budgets, per-user limits, rate limits, dedupe, simulation, factory-only accounts) protects the sponsor's HBAR. If the relayer is compromised it can waste sponsor HBAR or refuse service; it cannot move user funds without a valid owner/session signature.

## Recovery

Guardians (≤16, threshold ≥1, timelock ≥5 minutes) propose and approve a new owner. Reaching the threshold starts the timelock; anyone can execute after it. The owner can cancel at any time. Changing guardians cancels a pending recovery. Sessions and guardians cannot drive recovery.

## x402 authorization

`executeTransfer(from, asset, to, amount, authorization)` requires `from == address(this)` and a signature over `TransferAuthorization(from, asset, to, amount, nonce, validUntil)`. Session signers additionally need the `x402-payment` action and pass the same caps and recipient checks.

## Oracle failure behaviour

Session spend is priced in USD (6 decimals) through `IPriceOracle`. No oracle, an unsupported asset, or `ok = false` (stale/invalid) → `PriceUnavailable`. Swap-to-pay is priced at `amountInMaximum` (worst case).

## HTS / HSS caveats

- HTS system-contract calls return response codes; every call is checked (`HtsCallFailed`).
- Recipients must be associated to receive tokens; unassociated recipients get HIP-904 pending airdrops. The airdrop fee is charged to the calling contract's own HBAR (the sponsor pays only gas) and, for sessions, counts against the caps.
- Swap-to-pay checks the recipient's balance increased by at least `amountOut` and that no more than `amountInMaximum` was spent; the router approval is reset to zero afterwards.
- HSS recurring payments: creation and cancellation are owner-only; `executeSubscription` is permissionless but can only pay the owner-configured recipient and amount, once due. Scheduled executions are paid by the account (~2M gas each).
- Savings vault: sessions may only deposit (`vault-deposit`, USD-capped, owner-allowlisted vaults). Shares of any vault ever allowed are untransferable for sessions through every action (`WithdrawForbidden`).
- Launchpad tokens are created with no keys and a fixed supply; graduation pays the creator once; claims fund their own airdrop fee.

## Network fees count against session caps

Some actions make the network charge the account itself: a HIP-904 airdrop's fee (~1 HBAR per pending airdrop on
testnet) is taken from the calling contract's HBAR (see `docs/HEDERA_GOTCHAS.md`). For every session action and
session-signed x402 transfer, the account measures its HBAR balance before and after; anything beyond the HBAR the
action meant to send is priced by the oracle and charged to the same per-call and daily caps
(`SessionFeeCharged`). Exceeding a cap, or an unpriceable fee, reverts the whole action. Proven on testnet (flow 13).

## Account deployment

Accounts are full `ConsumerAccount` contracts deployed with CREATE2 by the factory, with the owner fixed in the
constructor and part of the salt (no initialization to front-run; the factory keeps no authority). The account's
creation code is stored in small data contracts (SSTORE2 pattern, STOP-prefixed so calling them does nothing) and
reassembled by the factory, whose constructor checks the code hash. Accounts are deliberately not proxies: Hedera
does not activate a contract's key for code running by delegatecall, so a proxy account could not be the payer of
its own HSS scheduled payments (observed on testnet: `INVALID_PAYER_SIGNATURE`).

## Secrets

Private keys live only in `.env` (gitignored) or server environment variables. No secret uses a `NEXT_PUBLIC_` name. The browser controller key used by the demo app is stored in `localStorage` — a testnet convenience, not production custody.
