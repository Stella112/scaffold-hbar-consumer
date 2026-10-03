# Hedera gotchas this template handles

- **Tinybars vs weibars.** Inside the EVM, `msg.value`, `address.balance` and `call{value:}` are tinybars (10⁻⁸ HBAR). JSON-RPC relays expose weibars (10⁻¹⁸); 1 tinybar = 10¹⁰ weibar. `sdk/src/hedera.ts` has the converters; contract HBAR amounts are always tinybars.
- **HTS association.** A recipient must be associated with a token (or have a free auto-association slot) to receive it. ConsumerAccount associates explicitly via `associateToken` and checks the response code. Unassociated recipients use the HIP-904 airdrop action, chosen by checking association on Mirror Node first — not by catching transfer failures.
- **HBAR vs WHBAR.** SaucerSwap pools use WHBAR (token 0.0.15058, contract 0.0.15057). The account wraps with `WHBAR.deposit()` (verified selector 0xd0e30db0).
- **Account IDs vs EVM addresses.** Tokens/contracts have long-zero addresses (`0.0.5449` → `0x…1549`). ECDSA accounts created with an alias must be addressed by their alias; the long-zero form of an alias account does not work in HTS calls.
- **System contracts return codes.** HTS (`0x167`) returns `int64` response codes (SUCCESS = 22) instead of reverting. Every call checks it.
- **Mirror Node lag.** Results appear a few seconds after consensus; `MirrorClient.waitForContractResult` polls.
- **No system contracts on plain local EVM.** Anvil has no `0x167`; unit tests use clearly named `MockHederaTokenService`, fork tests can use `hedera-forking`. Testnet claims come only from `yarn prove:testnet`.
- **Gas.** Hedera charges at least 80% of the gas limit, so the relayer estimates and pads instead of using a huge fixed limit.
- **ECDSA.** Accounts that sign EVM transactions (operator, sponsor) must be ECDSA (secp256k1) with an EVM alias. Controller and agent keys sign EIP-712 messages only and need no Hedera account. Not every Hedera account must be ECDSA — only the ones in EVM-facing flows here.
- **Fees on pending airdrops.** HIP-904 pending airdrops charge the submitter for the association/rent; the sponsor pays this for sponsored airdrops.

## HBAR from a contract to an aliased account's long-zero address fails

Sending native HBAR from a contract to the **long-zero** address (`0x000…<num>`) of an account that has an ECDSA
EVM alias reverts (`NativeTransferFailed` from `ConsumerAccount._transferOut`; reproduced on testnet 2026-10-03 with
Mirror Node `/contracts/call`). Sending to the account's **EVM alias** succeeds. Resolve recipients with
`resolveX402PayTo(mirror, accountId)`: alias when present, long-zero only for accounts without one. Session recipient
allowlists must use the same resolved address.

## Pyth on Hedera needs a Hermes API key

The Pyth contract on testnet holds prices last updated weeks ago (pull oracle); since 2026-08 Hermes requires an
API key to fetch updates. Supra's push feeds on testnet (`0x6Cd5…b917`) are updated by Supra (hourly or on a 5%
move) and need no key, so `SupraPriceOracle` uses them.
