# Recovery

The owner sets guardians (addresses — typically friends' ConsumerAccounts), an approval threshold and a waiting
period (≥ 5 minutes): `setGuardians(guardians, threshold, delay)`.

1. A guardian calls `proposeRecovery(newOwner)` (counts as its approval).
2. Other guardians `approveRecovery()` until the threshold is met; the waiting period starts.
3. After it, anyone calls `executeRecovery()`; the owner becomes `newOwner` and all sessions end.

The current owner can `cancelRecovery()` at any time before execution. Guardians that are ConsumerAccounts act
through sponsored owner intents, so they need no HBAR. Sessions cannot change guardians, thresholds or owners.

**In the app (Recovery page):** set guardians, see and cancel a pending recovery, help a friend (propose, approve,
execute), and — on the new device — copy the new key for guardians and link the recovered account afterwards.

Testnet flow 15: two guardian accounts, threshold 2, 5-minute timelock; early execution reverts
`RecoveryNotReady`; afterwards the old key is rejected and the new key pays.
