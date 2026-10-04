# Scheduling (Hedera Schedule Service)

`createSubscription(asset, to, amount, interval, firstAt, count, gasLimit)` (owner only) schedules
`executeSubscription(id)` through HSS `scheduleCall` on `0x16b`. Each execution pays one instalment and schedules the
next; no server or keeper is involved. `cancelSubscription` stops it and deletes the pending schedule.

- Execution is permissionless but inert: only the owner-configured payment, only when due, only while payments remain.
- The account pays the scheduled transactions (~2M gas each, because `scheduleCall` costs ~1.54M gas); the
  Recurring page shows the reserve needed.
- Instalments are scheduled 10 s after due because `block.timestamp` lags consensus inside scheduled calls.
- A failed reschedule never blocks the payment; the next instalment can be executed by anyone once due.

Testnet flow 10: two instalments executed by the network with no further transactions.
