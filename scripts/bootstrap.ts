/**
 * yarn bootstrap [--fund]
 *
 * 1. Validates the operator from .env and checks its balance on Mirror Node.
 * 2. Generates any missing role keys into .env (never printed).
 * 3. Plans account creation for sponsor / merchant / unassociated recipient and PRINTS every transfer.
 *    Nothing moves unless --fund is passed.
 * 4. Deploys ConsumerAccountFactory (operator pays), creates the HCS audit topic (sponsor-only submit key),
 *    associates the merchant with the demo tokens, and writes packages/sdk/deployments/testnet.json.
 *
 * Controller and agent keys intentionally get NO Hedera account: they only sign, and hold 0 HBAR.
 */
import { type Abi, type Address, type Hex, encodeDeployData, keccak256 } from "viem";
import fs from "node:fs";
import path from "node:path";
import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TokenAssociateTransaction,
  TopicCreateTransaction,
} from "@hiero-ledger/sdk";
import { privateKeyToAccount } from "viem/accounts";
import {
  HBAR,
  TINYBARS_PER_HBAR,
  type Deployment,
  accountCodeChunks,
  consumerAccountBytecode,
  consumerAccountFactoryAbi,
  consumerAccountFactoryBytecode,
  entityIdToLongZero,
  savingsVaultAbi,
  savingsVaultBytecode,
  supraPriceOracleAbi,
  supraPriceOracleBytecode,
  launchpadBuyActionAbi,
  launchpadBuyActionBytecode,
  tokenLaunchpadAbi,
  tokenLaunchpadBytecode,
} from "@sh/sdk";
import { hederaClient, mirror, publicClient, walletFor } from "./lib/clients";
import { ROOT, appendEnv, hex0x, operatorEnv, parseEnv } from "./lib/env";

const FUND = process.argv.includes("--fund");
const DEPLOYMENT_FILE = path.join(ROOT, "packages/sdk/deployments/testnet.json");

/** Initial balances for created role accounts, in HBAR. */
const PLAN = [
  { role: "SPONSOR", hbar: 40, maxAutoAssociations: 0, why: "pays sponsored transaction fees and HCS audit messages" },
  { role: "MERCHANT", hbar: 3, maxAutoAssociations: 0, why: "receives payments; associated with demo tokens below" },
  { role: "UNASSOCIATED", hbar: 2, maxAutoAssociations: 0, why: "HIP-904 recipient with no association and no free slots" },
] as const;

/** Demo tokens, verified on testnet 2026-10-03 (docs/SOURCES.md). */
const TOKENS = {
  USDC: { tokenId: "0.0.5449", decimals: 6, symbol: "USDC" },
  WHBAR: { tokenId: "0.0.15058", decimals: 8, symbol: "WHBAR" },
  SAUCE: { tokenId: "0.0.1183558", decimals: 6, symbol: "SAUCE" },
} as const;

// Supra push oracle (docs.supra.com/oracles/data-feeds/push-oracle/networks); pair indexes from the Supra
// data-feeds index, checked live on testnet 2026-10-03 (HBAR_USD 432 ≈ $0.1016, USDC_USD 89 ≈ $0.99999).
const SUPRA = {
  feed: "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917" as Address,
  // Testnet feeds update hourly or on a 5% move; allow two missed heartbeats before failing closed.
  maxAgeSeconds: 7200n,
  assets: [
    { label: "HBAR", asset: HBAR, pair: "HBAR_USD", pairIndex: 432n, decimals: 8 },
    { label: "WHBAR", asset: entityIdToLongZero(TOKENS.WHBAR.tokenId), pair: "HBAR_USD", pairIndex: 432n, decimals: 8 },
    { label: "USDC", asset: entityIdToLongZero(TOKENS.USDC.tokenId), pair: "USDC_USD", pairIndex: 89n, decimals: 6 },
  ],
} as const;

const SAUCERSWAP = { router: "0.0.1414040", quoter: "0.0.1390002", whbarContract: "0.0.15057" } as const;

const fmt = (tinybars: bigint) => `${(Number(tinybars) / 1e8).toFixed(4)} HBAR`;

async function main() {
  const op = parseEnv(operatorEnv, "bootstrap");
  const m = mirror();
  const opAcct = await m.getAccount(op.HEDERA_OPERATOR_ID);
  if (!opAcct) throw new Error(`operator ${op.HEDERA_OPERATOR_ID} not found on testnet Mirror Node`);
  const opEvm = privateKeyToAccount(hex0x(op.HEDERA_OPERATOR_KEY)).address.toLowerCase();
  if (opAcct.evm_address?.toLowerCase() !== opEvm) {
    throw new Error(
      `operator key does not match ${op.HEDERA_OPERATOR_ID}'s EVM alias; use the ECDSA key of an account created with an alias`,
    );
  }
  const opBalance = BigInt(opAcct.balance.balance);
  console.log(`PASS operator ${op.HEDERA_OPERATOR_ID} balance ${fmt(opBalance)}`);

  // Keys: generate what is missing (written to .env only).
  const generated: Record<string, string> = {};
  for (const k of ["CONTROLLER_PRIVATE_KEY", "AGENT_PRIVATE_KEY", ...PLAN.map(p => `${p.role}_PRIVATE_KEY`)]) {
    if (!process.env[k]) generated[k] = `0x${PrivateKey.generateECDSA().toStringRaw()}`;
  }
  if (Object.keys(generated).length) {
    appendEnv(generated);
    console.log(`INFO generated ${Object.keys(generated).join(", ")} into .env (values not shown)`);
  }

  const toCreate = PLAN.filter(p => !process.env[`${p.role}_ACCOUNT_ID`]);
  const total = toCreate.reduce((s, p) => s + BigInt(p.hbar) * TINYBARS_PER_HBAR, 0n);
  if (toCreate.length) {
    console.log("\nPlanned transfers from the operator:");
    for (const p of toCreate) console.log(`  create ${p.role.padEnd(13)} with ${p.hbar} HBAR — ${p.why}`);
    console.log(`  total ${fmt(total)} (+ network fees)`);
    if (!FUND) {
      console.log("\nNothing was sent. Re-run with `yarn bootstrap --fund` to create and fund these accounts.");
      return;
    }
    if (opBalance < total + 20n * TINYBARS_PER_HBAR) throw new Error("operator balance too low for plan + deploy fees");
  }

  const client = hederaClient(op.HEDERA_OPERATOR_ID, op.HEDERA_OPERATOR_KEY);
  try {
    for (const p of toCreate) {
      const key = PrivateKey.fromStringECDSA(process.env[`${p.role}_PRIVATE_KEY`]!.replace(/^0x/, ""));
      const resp = await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(key.publicKey)
        .setInitialBalance(new Hbar(p.hbar))
        .setMaxAutomaticTokenAssociations(p.maxAutoAssociations)
        .execute(client);
      const receipt = await resp.getReceipt(client);
      const id = receipt.accountId!.toString();
      appendEnv({ [`${p.role}_ACCOUNT_ID`]: id });
      console.log(`PASS created ${p.role} ${id} (tx ${resp.transactionId.toString()})`);
    }

    const deployment: Deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf8"));

    // Merchant association with demo tokens (merchant signs its own association).
    const merchantId = process.env.MERCHANT_ACCOUNT_ID!;
    const merchantClient = hederaClient(merchantId, process.env.MERCHANT_PRIVATE_KEY!);
    try {
      await mirror().waitForAccount(merchantId);
      const missing: string[] = [];
      for (const t of Object.values(TOKENS)) if (!(await mirror().isAssociated(merchantId, t.tokenId))) missing.push(t.tokenId);
      if (missing.length) {
        const r = await new TokenAssociateTransaction().setAccountId(merchantId).setTokenIds(missing).execute(merchantClient);
        await r.getReceipt(merchantClient);
        console.log(`PASS associated merchant with ${missing.join(", ")}`);
      }
    } finally {
      merchantClient.close();
    }

    const pc = publicClient();
    const wallet = walletFor(op.HEDERA_OPERATOR_KEY);
    // Estimate rather than guess (the factory embeds ConsumerAccount's creation code), capped at Hedera's 15M limit.
    const deploy = async (label: string, abi: Abi, bytecode: Hex, args: readonly unknown[]) => {
      const data = encodeDeployData({ abi, bytecode, args });
      const estimate = await pc.estimateGas({ account: wallet.account!, data });
      const gas = [(estimate * 12n) / 10n, 15_000_000n].reduce((a, c) => (a < c ? a : c));
      console.log(`  ${label} deploy gas: estimate ${estimate}, limit ${gas}`);
      const hash = await wallet.deployContract({ abi, bytecode, args, gas });
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`${label} deploy failed: ${hash}`);
      const result = await mirror().waitForContractResult(hash);
      const contractId = result.created_contract_ids[0] ?? result.contract_id ?? undefined;
      console.log(`PASS deployed ${label} ${contractId} (${rcpt.contractAddress}) tx ${hash}`);
      return { address: rcpt.contractAddress, contractId };
    };

    // USD price oracle for session caps: Supra push feeds, unless PRICE_ORACLE points at another IPriceOracle.
    const customOracle = process.env.PRICE_ORACLE as Address | undefined;
    if (customOracle) {
      deployment.oracle = { address: customOracle, kind: "custom", label: "PRICE_ORACLE from .env" };
    } else if (!deployment.oracle || deployment.oracle.kind !== "supra-push") {
      const assets = SUPRA.assets.map(a => a.asset);
      const pairs = SUPRA.assets.map(a => a.pairIndex);
      const decimals = SUPRA.assets.map(a => a.decimals);
      const o = await deploy("SupraPriceOracle", supraPriceOracleAbi, supraPriceOracleBytecode, [
        SUPRA.feed,
        SUPRA.maxAgeSeconds,
        assets,
        pairs,
        decimals,
      ]);
      deployment.oracle = {
        address: o.address,
        kind: "supra-push",
        label: `Supra push feed ${SUPRA.feed}: ${SUPRA.assets.map(a => `${a.label}→${a.pair}(${a.pairIndex})`).join(", ")}; max age ${SUPRA.maxAgeSeconds}s`,
        contractId: o.contractId,
      };
    }

    // Factory: redeploy when the contract code changed (new accounts get the new ConsumerAccount) or when its
    // default oracle differs (new accounts take the factory's default oracle).
    // The factory deploys ConsumerAccount from stored creation code; a change to either contract means a new factory.
    const codeHash = keccak256(`${consumerAccountFactoryBytecode}${consumerAccountBytecode.slice(2)}`);
    if (deployment.factory && deployment.factoryCodeHash !== codeHash) {
      console.log("  ConsumerAccount or factory bytecode changed; deploying new account code chunks and factory");
      deployment.factory = undefined;
    }
    if (deployment.factory) {
      const current = await pc.readContract({
        address: deployment.factory,
        abi: consumerAccountFactoryAbi,
        functionName: "defaultOracle",
      });
      if (current.toLowerCase() !== deployment.oracle.address.toLowerCase()) {
        console.log(`  factory default oracle ${current} != ${deployment.oracle.address}; deploying a new factory`);
        deployment.factory = undefined;
      }
    }
    if (!deployment.factory) {
      // ConsumerAccount's creation code goes into small data contracts; the factory reassembles it, so accounts
      // are full contracts (Hedera does not activate a proxy's key for scheduled or signed system calls).
      const { chunks, codeHash: accountCodeHash } = accountCodeChunks();
      const chunkAddresses: Address[] = [];
      for (const [i, data] of chunks.entries()) {
        const estimate = await pc.estimateGas({ account: wallet.account!, data });
        const hash = await wallet.sendTransaction({ data, gas: (estimate * 12n) / 10n });
        const rcpt = await pc.waitForTransactionReceipt({ hash });
        if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`code chunk ${i} deploy failed: ${hash}`);
        chunkAddresses.push(rcpt.contractAddress);
        console.log(`PASS deployed account code chunk ${i + 1}/${chunks.length} (${rcpt.contractAddress})`);
      }
      deployment.accountCodeChunks = chunkAddresses;
      delete deployment.accountImplementation;
      const f = await deploy("ConsumerAccountFactory", consumerAccountFactoryAbi, consumerAccountFactoryBytecode, [
        chunkAddresses,
        accountCodeHash,
        deployment.oracle.address,
      ]);
      deployment.factory = f.address;
      deployment.factoryContractId = f.contractId;
      deployment.factoryCodeHash = codeHash;
    }

    // Recipes: a WHBAR savings vault (agents may deposit, never withdraw) and the token launchpad.
    if (!deployment.vaults?.WHBAR) {
      const whbar = entityIdToLongZero(TOKENS.WHBAR.tokenId);
      const v = await deploy("SavingsVault", savingsVaultAbi, savingsVaultBytecode, [whbar, "Savings WHBAR", "svWHBAR"]);
      deployment.vaults = { ...deployment.vaults, WHBAR: { address: v.address, contractId: v.contractId, asset: whbar } };
    }
    const launchpadHash = keccak256(tokenLaunchpadBytecode);
    if (!deployment.launchpad || deployment.launchpad.codeHash !== launchpadHash) {
      const l = await deploy("TokenLaunchpad", tokenLaunchpadAbi, tokenLaunchpadBytecode, []);
      deployment.launchpad = { address: l.address, contractId: l.contractId, codeHash: launchpadHash };
    }

    // Action modules (custom typed actions installed per account by its owner).
    if (deployment.launchpad) {
      const moduleHash = keccak256(`${launchpadBuyActionBytecode}${deployment.launchpad.address.slice(2)}`);
      if (deployment.actionModules?.launchpadBuy?.codeHash !== moduleHash) {
        const m = await deploy("LaunchpadBuyAction", launchpadBuyActionAbi, launchpadBuyActionBytecode, [deployment.launchpad.address]);
        deployment.actionModules = {
          ...deployment.actionModules,
          launchpadBuy: { address: m.address, contractId: m.contractId, codeHash: moduleHash },
        };
      }
    }

    // HCS audit topic: only the sponsor key can submit.
    if (!deployment.auditTopicId) {
      const sponsorKey = PrivateKey.fromStringECDSA(process.env.SPONSOR_PRIVATE_KEY!.replace(/^0x/, ""));
      const r = await new TopicCreateTransaction()
        .setTopicMemo("scaffold-hbar-consumer policy audit v1")
        .setSubmitKey(sponsorKey.publicKey)
        .execute(client);
      deployment.auditTopicId = (await r.getReceipt(client)).topicId!.toString();
      appendEnv({ HCS_AUDIT_TOPIC_ID: deployment.auditTopicId });
      console.log(`PASS created HCS audit topic ${deployment.auditTopicId}`);
    }

    deployment.tokens = Object.fromEntries(
      Object.entries(TOKENS).map(([k, t]) => [k, { ...t, address: entityIdToLongZero(t.tokenId) }]),
    );
    deployment.saucerswap = {
      router: entityIdToLongZero(SAUCERSWAP.router),
      quoter: entityIdToLongZero(SAUCERSWAP.quoter),
      whbar: entityIdToLongZero(SAUCERSWAP.whbarContract),
    };
    deployment.updatedAt = new Date().toISOString();
    fs.writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`PASS wrote packages/sdk/deployments/testnet.json`);
    console.log("\nNext: `yarn doctor`, then `yarn prove:testnet`.");
  } finally {
    client.close();
  }
}

main().catch(e => {
  console.error(`FAIL ${(e as Error).message}`);
  process.exit(1);
});
