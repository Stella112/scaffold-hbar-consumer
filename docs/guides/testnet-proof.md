# Testnet proof

| Command | Does |
| --- | --- |
| `yarn doctor` | toolchain, env (never prints secrets), RPC, Mirror Node, balances and key/alias match, factory, topic, SaucerSwap quote, oracle price, x402 |
| `yarn bootstrap [--fund]` | plan (dry run) or create sponsor/merchant/recipient accounts, deploy oracle, factory, vault, launchpad, modules, create the HCS topic, write `packages/sdk/deployments/testnet.json`; redeploys contracts whose bytecode changed |
| `yarn prove:testnet` | runs every flow through the real relayer and writes `TESTNET_VERIFICATION.md`; `PROVE_FLOWS=1,2,14` runs a subset |

Evidence rows record actor, account, contract, asset, input, expected and actual results, transaction ID and
HashScan link, Mirror Node query and result, HCS reference and status. Nothing is written by hand; a failing flow
is recorded as FAIL. Local Anvil and Foundry runs are never used as testnet evidence.

Feature statuses (Developer page, `docs/BUILD_STATE.md`): `VERIFIED_TESTNET`, `VERIFIED_LOCAL`, `EXPERIMENTAL`,
`READ_ONLY`, `BLOCKED_EXTERNAL`.
