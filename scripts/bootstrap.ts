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
  consumerAccountFactoryAbi,
  consumerAccountFactoryBytecode,
  entityIdToLongZero,
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

    // Factory
    if (!deployment.factory) {
      const pc = publicClient();
      const wallet = walletFor(op.HEDERA_OPERATOR_KEY);
      const oracle = (process.env.PRICE_ORACLE as `0x${string}` | undefined) ?? HBAR;
      const hash = await wallet.deployContract({
        abi: consumerAccountFactoryAbi,
        bytecode: consumerAccountFactoryBytecode,
        args: [oracle],
        gas: 4_000_000n,
      });
      const rcpt = await pc.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success" || !rcpt.contractAddress) throw new Error(`factory deploy failed: ${hash}`);
      const result = await mirror().waitForContractResult(hash);
      deployment.factory = rcpt.contractAddress;
      deployment.factoryContractId = result.created_contract_ids[0] ?? result.contract_id ?? undefined;
      console.log(`PASS deployed ConsumerAccountFactory ${deployment.factoryContractId} (${rcpt.contractAddress}) tx ${hash}`);
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
