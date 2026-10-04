# Custom actions

New capabilities are **action modules**: read-only planners implementing `IActionModule.plan(account, actionData)`
that return the worst-case spend (`spendAsset`, `recipient`, `spendAmount`) and the calls to make. The owner
installs one per action ID (`selfCall.setActionModule`) and grants the ID to sessions. ConsumerAccount then:

1. charges the declared spend against the session's USD caps and recipient allowlist;
2. executes the calls itself, rejecting calls to itself or to HTS;
3. reverts if more than the declared amount of `spendAsset` left, and charges any extra HBAR outflow.

Built-in and reserved IDs cannot be overridden. Modules are trusted like owner-installed code: review them.

```bash
yarn new:action tip-jar
```

creates `contracts/actions/TipJarAction.sol`, `test/actions/TipJarAction.t.sol` (allowed path, cap denial, missing
permission), `packages/sdk/src/customActions/tipJar.ts` (ID + encoder/decoder), a round-trip test and
`docs/actions/tip-jar.md`. The generated code compiles, passes its tests and `forge fmt` unchanged (checked in CI).
