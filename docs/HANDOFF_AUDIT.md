# Handoff: contracts & Hedera verification audit

**Milestone:** M0–M4 contracts ready for audit (M2/M3/M4 testnet proofs pending operator credentials).

**Objective:** review `packages/foundry/contracts/` for authorization bypasses, policy-order mistakes and Hedera-specific semantics; run the testnet proof and confirm results independently.

**Files owned by the audit:** `packages/foundry/**` (report findings; changes to security-sensitive code go through a logged decision).

**Frozen interfaces:** `docs/CONTRACT_INTERFACES.md`.

**Security invariants:** `docs/SECURITY_INVARIANTS.md` (each mapped to tests).

**Authoritative sources:** `docs/SOURCES.md`.

**Required checks**

1. `cd packages/foundry && forge fmt --check && forge build && forge test` — 60 tests.
2. `yarn sdk:test && yarn relayer:test` — Anvil e2e uses the compiled contracts.
3. Focus areas:
   - `executeOwnerIntent`: session signer must hit `RawCallForbidden` before any external call.
   - `_chargeSession`: pricing/cap math, day roll-over, `uint128` casts.
   - `_swapToPay`: path parsing (`_firstAddress`/`_lastAddress`), approval reset, balance-delta check, reentrancy via router.
   - `executeTransfer`: binding of all six fields; nonce consumption only on success.
   - Recovery: threshold change while a recovery is pending (`setGuardians` cancels it), owner equals guardian edge cases.
   - HTS: `_airdrop` int64 conversion; response-code handling.
4. Testnet: `yarn doctor`, `yarn bootstrap --fund`, `yarn prove:testnet`; compare `TESTNET_VERIFICATION.md` links against HashScan.

**Known blockers:** U7 (oracle), U9/U10 (x402 transferExecutor facilitator support) — see `docs/OPEN_QUESTIONS.md`.

**Forbidden scope changes:** no session raw-call path; no weakening of fail-closed pricing; no mocks in proof paths.
