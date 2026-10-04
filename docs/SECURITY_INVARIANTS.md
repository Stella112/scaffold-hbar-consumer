# Security invariants → tests

| # | Invariant | Enforced in | Test(s) |
| --- | --- | --- | --- |
| 1 | Only valid owner/session authorization executes | `ConsumerAccount` signature recovery | `test_wrongSignerFails`, `test_sessionTamperedPayloadFails` |
| 2 | Relayer identity creates no authority | no `msg.sender` checks on execute paths | `test_relayerIdentityGrantsNothing`, relayer `does not sponsor contracts outside its factory` |
| 3 | Nonces single-use | `_useIntent` | `test_exactReplayFails`, `test_sessionReplayFails`, `test_authorizationIsSingleUse` |
| 4 | Expired authorizations fail | `_useIntent`, swap deadline | `test_expiredFails`, `test_staleDeadline` |
| 5 | Sessions cannot execute raw calls | `executeOwnerIntent` | `test_sessionRawCallForbiddenBeforeAnyInteraction` (target hit count stays 0), sdk/relayer anvil e2e |
| 6–9 | Sessions cannot change owner / guardians / sessions / limits | `onlySelf` + reserved IDs + `grantSession` rejects privileged IDs | `test_sessionCannotChangeOwnerGuardiansOrSessionsDirectly`, `test_sessionCannotSelfCallThroughOwnerPath`, `test_privilegeEscalationAction`, `test_grantRejectsPrivilegedActions`, `test_sessionCannotAllowlistRouter` |
| 10–11 | Sponsor/relayer have no user-fund role | factory has no admin; account has no sponsor role | `test_factoryHoldsNoAuthority` |
| 12 | Recovery needs threshold + timelock | `_approveRecovery`, `executeRecovery` | `test_belowThresholdCannotExecute`, `test_thresholdThenTimelockThenExecute` |
| 13 | Owner can cancel recovery | `cancelRecovery` | `test_ownerCancelsPendingRecovery` |
| 14 | Unpriceable session spend fails closed | `_chargeSession` | `test_unpriceableSpendFailsClosed`, `test_noOracleFailsClosed` |
| 15 | Agent cannot withdraw vault assets | reserved withdrawal IDs + `isVaultShare` blocks share transfers in `_chargeSession` | `test_withdrawForbidden`, `test_sessionCannotWithdrawOrRedeem`, `test_sessionCannotPayOutVaultShares`, `test_sessionCannotMoveVaultSharesThroughX402`, `test_sharesStayLockedForSessionsAfterVaultIsDelisted`; testnet flow 11 |
| 16 | x402 authorization cannot be redirected | EIP-712 binds from/asset/to/amount/nonce/expiry | `test_cannotRedirectRecipientAssetOrAmount` |
| 17 | Swap-to-pay cannot under-deliver | balance-delta check | `test_underdeliveryCannotReportSuccess`, `test_overspendRejected` |
| 18 | HTS response codes checked | `associateToken`, `_airdrop`, raw 0x167 forbidden | `test_associateTokenChecksResponseCode`, `test_airdropActionCallsHtsAndChecksCode`, `test_rawHtsCallMustUseTypedHelper` |
| 19 | Launchpad graduation idempotent | `graduated` set before the HBAR transfer, `nonReentrant` | `test_graduateOnlyAfterTargetAndExactlyOnce`, `test_reentrantCreatorIsPaidOnce`; testnet flow 12 (second call `AlreadyGraduated`) |
| 21 | Recurring payments pay only the owner-configured instalment, once due | owner-only create/cancel; `executeSubscription` checks due time and remaining count | `SubscriptionsTest`; testnet flow 10 |
| 22 | Launchpad claim fees never use other launches' HBAR | balance-delta check, revert `InsufficientFeePayment` | `test_claimRefundsUnspentFeeAndFailsWithoutFeeFunds` |
| 23 | Oracle fails closed (stale / future / zero / unsupported / reverting) and rounds up | `SupraPriceOracle.quoteUsd6` | `SupraPriceOracleTest` incl. `testFuzz_quoteNeverUndershoots` |
| 24 | Network fees an agent causes count against its caps | `_chargeHbarOutflow` on session actions and x402 | `AgentFeeCapsTest`; testnet flow 13 |
| 25 | Accounts are full contracts deployed from the hash-checked stored code, owner fixed in the constructor | `ConsumerAccountFactory` + `CodeChunkStore` | `ChunkedFactoryTest` |
| 26 | Action modules cannot exceed their declared spend, call the account or HTS, or override built-in / reserved IDs | `_runModule`, `setActionModule` | `ActionModulesTest` |
| 27 | Launchpad graduation runs once; LP stays locked; creator fee capped at 10% | `TokenLaunchpad.graduate` | `TokenLaunchpadTest` (incl. reentrancy, front-run pool, fuzzed curve maths); testnet flow 12 |
| 28 | Agent session invariants hold under random action sequences | handler-driven Foundry invariants | `test/invariant/SessionInvariants.t.sol` |
| 20 | No server secret in browser bundle | env split: no secret uses `NEXT_PUBLIC_` | gitleaks in CI (`.github/workflows/ci.yaml`) |

Reviewed static-analysis exclusions are listed in `packages/foundry/foundry.toml` with reasons.
