# Sources

Every external value this repository depends on, where it came from, and how it was checked.
Values marked **live** were observed against Hedera testnet; values marked **source** were read from current implementation code.

| Value | Result | Source | Checked | Method |
| --- | --- | --- | --- | --- |
| Hedera testnet chain ID | `296` | `https://testnet.hashio.io/api` | 2026-10-03 | live: `cast chain-id` |
| JSON-RPC endpoint | `https://testnet.hashio.io/api` | create-scaffold-hbar `src/utils/consts.ts` `HEDERA_NETWORKS` | 2026-10-03 | source + live |
| Mirror Node endpoint | `https://testnet.mirrornode.hedera.com/api/v1` | create-scaffold-hbar `src/utils/consts.ts` | 2026-10-03 | source + live (`/tokens/0.0.5449`) |
| External template syntax | `npx create-scaffold-hbar@latest --template <owner>/<repo>[#branch]` | create-scaffold-hbar `contributors/THIRD-PARTY-TEMPLATES.md`, `src/utils/parse-github-template-ref.ts` | 2026-10-03 | source |
| `template.json` schema | `name`, `description?`, `version?`, `create-scaffold-hbar.{rename,instructions,requirements,envVars,capabilities,defaults,outro}` | create-scaffold-hbar `src/types.ts` `TemplateManifestSchema` | 2026-10-03 | source (zod schema) |
| Template copy behaviour | giget download; skips `.git`, `node_modules`, `.next`, `.env`; removes unselected framework packages; strips Foundry lib submodules and re-installs them from `.gitmodules` + `foundry.lock` tags | create-scaffold-hbar `src/tasks/copy-template-files.ts`, `src/utils/resolve-foundry-libraries.ts` | 2026-10-03 | source |
| Local scaffold seam | `CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR=<dir>` copies a local tree instead of downloading | create-scaffold-hbar `src/tasks/copy-template-files.ts` | 2026-10-03 | source |
| Harness recipe directory | `.harness/` (runtime dirs `runs/`, `cache/`, `runtime/` ignored); `harness:*` root scripts preserved | create-scaffold-hbar `src/utils/harness-recipe.ts`, `contributors/TEMPLATES.md` | 2026-10-03 | source |
| Hedera JS SDK package | `@hiero-ledger/sdk` (npm latest `2.89.1`, modified 2026-09-28) | scaffold-hbar `templates/blank-template` `packages/nextjs/package.json`; `npm view` | 2026-10-03 | source + registry |
| Base template | `hedera-dev/scaffold-hbar` branch `templates/blank-template` (Yarn `3.2.3`, Node `>=20.18.3`) | git clone | 2026-10-03 | source |
| Foundry libraries | forge-std `v1.15.0`, openzeppelin-contracts `v5.6.1`, solidity-bytes-utils `v0.8.4`, hedera-forking `v0.1.2` | blank-template `packages/foundry/foundry.lock` | 2026-10-03 | source |
| HTS system contract | `0x167`; `associateToken`, `airdropTokens`, `cancelAirdrops`, structs `AccountAmount`, `TokenTransferList`, `PendingAirdrop`; SUCCESS = `22` | hiero-ledger/hiero-contracts `contracts/token-service/IHederaTokenService.sol`, `contracts/extensions/hrc-904/Airdrop.sol` | 2026-10-03 | source |
| HSS / HIP-1215 interface | `scheduleCall`, `scheduleCallWithPayer`, `executeCallOnPayerSignature`, `deleteSchedule`, `hasScheduleCapacity` | hiero-contracts `contracts/schedule-service/IHRC1215.sol` | 2026-10-03 | source |
| x402 Hedera scheme | `exact`; methods `cryptoTransfer` (default) and `transferExecutor`; executor `executeTransfer(address,address,address,uint256,bytes)` selector `0xea8f19fd` | x402-foundation/x402 `specs/schemes/exact/scheme_exact_hedera.md` | 2026-10-03 | source; selector asserted in `ConsumerAccount.t.sol` |
| x402 packages | `@x402/hedera@2.28.0`, `@x402/core@2.28.0` | npm registry | 2026-10-03 | registry |
| x402 `transferExecutor` implementation | **Not implemented** in `@x402/hedera@2.28.0` (no executor code in `src/`) | x402 `typescript/packages/mechanisms/hedera/src` | 2026-10-03 | source grep |
| SaucerSwap V2 SwapRouter | `0.0.1414040` (`0x0000000000000000000000000000000000159398`) | docs.saucerswap.finance contract deployments | 2026-10-03 | docs + live: `factory()` = `0.0.1197038`, `WHBAR()` = `0.0.15057`; bytecode contains `exactOutput` `0xf28c0498`, `exactOutputSingle`, `multicall`, `refundETH`, `unwrapWHBAR` |
| SaucerSwap V2 QuoterV2 | `0.0.1390002` (`0x…1535b2`) | docs | 2026-10-03 | live quotes below |
| SaucerSwap V2 Factory | `0.0.1197038` (`0x…1243ee`) | docs | 2026-10-03 | live `getPool` |
| WHBAR contract / token | `0.0.15057` / `0.0.15058` | docs | 2026-10-03 | live (router `WHBAR()`) |
| SAUCE token | `0.0.1183558` | docs | 2026-10-03 | live pool lookup |
| USDC (testnet) | `0.0.5449`, symbol USDC, 6 decimals, FUNGIBLE_COMMON | Mirror Node `/tokens/0.0.5449` | 2026-10-03 | live |
| Pool WHBAR/SAUCE 0.30% | `0x37814eDc1ae88cf27c0C346648721FB04e7E0AE7`, liquidity `1102169831174` | V2 factory `getPool` | 2026-10-03T00:26Z | live |
| Pool USDC(0.0.5449)/WHBAR 0.30% | `0x914B98992d7eD602D1f5d9084ECe8160Fc0e741a`, liquidity `125349437318` | V2 factory `getPool` | 2026-10-03T00:26Z | live |
| Quote: exact-out 1 USDC from WHBAR | `52277356` WHBAR base units | QuoterV2 `quoteExactOutputSingle` | 2026-10-03T00:26Z | live |
| Quote: exact-out 1 USDC from SAUCE via WHBAR | `21005501` SAUCE base units | QuoterV2 `quoteExactOutput` path `USDC‑3000‑WHBAR‑3000‑SAUCE` | 2026-10-03T00:26Z | live |
| SaucerSwap `exactOutput` semantics | `ExactOutputParams{bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum}`; path reversed (output first); 3-byte fee; recipient must be associated with output token; approve router for non-HBAR input | docs.saucerswap.finance/developers/v2/swap/swap-tokens-for-tokens | 2026-10-03 | docs + bytecode selector |

Liquidity and quotes change over time; `yarn doctor` re-queries them before demos.
