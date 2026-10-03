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
- Recipients must be associated to receive tokens; unassociated recipients get HIP-904 pending airdrops (fees charged to the submitter, i.e. the sponsor).
- Swap-to-pay checks the recipient's balance increased by at least `amountOut` and that no more than `amountInMaximum` was spent; the router approval is reset to zero afterwards.
- HSS scheduled payments are not implemented in this version.

## Known limitation: airdrop fees are outside session caps

A session's USD caps price the *tokens* an action moves. A HIP-904 `airdrop` action also makes the account pay the
airdrop fee from its own HBAR (~1 HBAR per pending airdrop on testnet; see `docs/HEDERA_GOTCHAS.md`), and that fee is
not charged against the caps. A session holding the `airdrop` action could therefore spend the account's HBAR on
fees beyond its limits. The app never grants `airdrop` to agents (Agent page grants `payment`, `x402-payment` and
`vault-deposit`); do not grant it to sessions you do not trust. Closing this on-chain (pricing the fee into the cap)
needs an account change that does not fit the current factory size margin; see `docs/DECISIONS.md`.

## Secrets

Private keys live only in `.env` (gitignored) or server environment variables. No secret uses a `NEXT_PUBLIC_` name. The browser controller key used by the demo app is stored in `localStorage` — a testnet convenience, not production custody.
