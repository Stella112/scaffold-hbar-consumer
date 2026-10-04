# Account model

## ConsumerAccount

A smart account per user, holding HBAR, HTS tokens, vault shares and launch tokens. It has one `owner` key (the
controller), any number of **sessions** (delegated keys), optional **guardians**, an `oracle`, and owner-managed
allowlists (swap routers, vaults, action modules).

| Entry point | Signed by | Authority |
| --- | --- | --- |
| `executeOwnerIntent(intent, sig)` | owner | arbitrary calls (`target, value, data`), except raw HTS `0x167` calls |
| `executeSessionAction(action, sig)` | owner or session | one typed action (`actionId, actionData`) |
| `executeTransfer(from, asset, to, amount, auth)` | owner or session with `x402-payment` | one x402 transfer |
| `createSubscription`, `setGuardians`, `grantSession`, `setVault`, `setActionModule`, … | self only | reached through an owner intent |

Every signature is EIP-712 over a domain bound to chain ID 296 and the account address, with a single-use nonce
and an expiry. Submitter identity (`msg.sender`) grants nothing.

## Factory

`ConsumerAccountFactory.createAccount(owner, salt)` deploys a full ConsumerAccount with CREATE2; the owner is part
of the salt, so nobody can take another owner's address. The account's creation code lives in small data
contracts (SSTORE2 pattern) that the factory reassembles and hash-checks; this keeps the factory ~1.4 KB.
`isAccount(address)` records every account it deployed, which keeps recovered accounts eligible for sponsorship.

Accounts are deliberately **not** proxies: Hedera activates a contract's key only for its own code, so a
delegatecall proxy cannot be the payer of its own scheduled transactions (`docs/HEDERA_GOTCHAS.md`).

## SDK

```ts
import { buildOwnerIntent, signOwnerIntent, selfCall, toSponsorRequest } from "@sh/sdk";
const intent = buildOwnerIntent([selfCall.grantSession(account, { key, expiresAt, perCallCapUsd6, dailyCapUsd6, allowedActions, allowedRecipients })]);
const req = toSponsorRequest.ownerIntent(296, account, intent, await signOwnerIntent(controller, 296, account, intent));
await fetch("/api/sponsor", { method: "POST", body: JSON.stringify(req) });
```
