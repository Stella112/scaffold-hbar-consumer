/**
 * yarn doctor — PASS / WARN / FAIL checks for toolchain, configuration and live testnet dependencies.
 * Never prints secret values.
 */
import { spawnSync } from "node:child_process";
import { parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HEDERA_TESTNET, entityIdToLongZero, testnetDeployment } from "@sh/sdk";
import { mirror, publicClient } from "./lib/clients";
import { hex0x } from "./lib/env";

type Level = "PASS" | "WARN" | "FAIL";
const results: { level: Level; check: string; detail: string }[] = [];
const report = (level: Level, check: string, detail: string) => {
  results.push({ level, check, detail });
  console.log(`${level.padEnd(4)}  ${check.padEnd(28)} ${detail}`);
};

const tool = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0]! : null;
};

async function safe(check: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (e) {
    report("FAIL", check, (e as Error).message.split("\n")[0]!);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
report(major > 20 || (major === 20 && minor >= 18) ? "PASS" : "FAIL", "node >= 20.18.3", process.versions.node);
for (const [name, cmd, args] of [
  ["git", "git", ["--version"]],
  ["forge", "forge", ["--version"]],
] as const) {
  const v = tool(cmd, [...args]);
  report(v ? "PASS" : "FAIL", name, v ?? "not found on PATH");
}

const env = process.env;
const present = (k: string) => Boolean(env[k] && env[k]!.trim());
for (const k of ["HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY"]) report(present(k) ? "PASS" : "FAIL", `env ${k}`, present(k) ? "set" : "missing");
for (const k of ["SPONSOR_ACCOUNT_ID", "SPONSOR_PRIVATE_KEY", "CONTROLLER_PRIVATE_KEY", "AGENT_PRIVATE_KEY", "MERCHANT_ACCOUNT_ID", "UNASSOCIATED_ACCOUNT_ID", "HCS_AUDIT_TOPIC_ID"]) {
  report(present(k) ? "PASS" : "WARN", `env ${k}`, present(k) ? "set" : "missing — run `yarn bootstrap --fund`");
}

const pc = publicClient();
const m = mirror();

await safe("rpc chain id", async () => {
  const id = await pc.getChainId();
  report(id === HEDERA_TESTNET.chainId ? "PASS" : "FAIL", "rpc chain id", `${id}`);
});

await safe("mirror node", async () => {
  await m.get("/network/exchangerate");
  report("PASS", "mirror node", m.baseUrl);
});

for (const [role, idKey, keyKey, min] of [
  ["operator", "HEDERA_OPERATOR_ID", "HEDERA_OPERATOR_KEY", 20n],
  ["sponsor", "SPONSOR_ACCOUNT_ID", "SPONSOR_PRIVATE_KEY", 5n],
] as const) {
  if (!present(idKey)) continue;
  await safe(`${role} balance`, async () => {
    const acct = await m.getAccount(env[idKey]!);
    if (!acct) return report("FAIL", `${role} balance`, `${env[idKey]} not found`);
    const hbar = BigInt(acct.balance.balance) / 100_000_000n;
    report(hbar >= min ? "PASS" : "WARN", `${role} balance`, `${env[idKey]} ${hbar} HBAR`);
    if (present(keyKey)) {
      const evm = privateKeyToAccount(hex0x(env[keyKey]!)).address.toLowerCase();
      report(acct.evm_address?.toLowerCase() === evm ? "PASS" : "FAIL", `${role} key matches alias`, acct.evm_address ? "checked" : "account has no EVM alias");
    }
  });
}

if (present("CONTROLLER_PRIVATE_KEY")) {
  await safe("controller zero HBAR", async () => {
    const c = privateKeyToAccount(hex0x(env.CONTROLLER_PRIVATE_KEY!)).address;
    const b = await m.getHbarBalance(c);
    report(b.tinybars === 0n ? "PASS" : "WARN", "controller zero HBAR", `${c} exists=${b.exists} tinybars=${b.tinybars}`);
  });
}

await safe("factory deployed", async () => {
  if (!testnetDeployment.factory) return report("WARN", "factory deployed", "not yet — run `yarn bootstrap --fund`");
  const code = await pc.getCode({ address: testnetDeployment.factory });
  report(code && code.length > 2 ? "PASS" : "FAIL", "factory deployed", `${testnetDeployment.factoryContractId} ${testnetDeployment.factory}`);
});

await safe("hcs audit topic", async () => {
  const t = testnetDeployment.auditTopicId ?? env.HCS_AUDIT_TOPIC_ID;
  if (!t) return report("WARN", "hcs audit topic", "not created yet");
  await m.get(`/topics/${t}`);
  report("PASS", "hcs audit topic", t);
});

await safe("saucerswap v2", async () => {
  const router = entityIdToLongZero("0.0.1414040");
  const factory = await pc.readContract({ address: router, abi: parseAbi(["function factory() view returns (address)"]), functionName: "factory" });
  const quote = (await pc.readContract({
    address: entityIdToLongZero("0.0.1390002"),
    abi: parseAbi([
      "function quoteExactOutputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)",
    ]),
    functionName: "quoteExactOutputSingle",
    args: [[entityIdToLongZero("0.0.15058"), entityIdToLongZero("0.0.5449"), 100_000n, 3000, 0n]],
  })) as readonly [bigint, bigint, number, bigint];
  report(
    factory.toLowerCase() === entityIdToLongZero("0.0.1197038").toLowerCase() ? "PASS" : "FAIL",
    "saucerswap v2",
    `router ok; 0.1 USDC costs ${quote[0]} WHBAR units right now`,
  );
});

report(
  testnetDeployment.oracle ? "PASS" : "WARN",
  "price oracle",
  testnetDeployment.oracle ? testnetDeployment.oracle.label : "none configured: session spend fails closed (PRICE_UNAVAILABLE)",
);
report("WARN", "x402 transferExecutor", "@x402/hedera@2.28.0 does not implement transferExecutor (docs/OPEN_QUESTIONS.md U9/U10)");

const fails = results.filter(r => r.level === "FAIL").length;
console.log(`\n${fails ? `${fails} FAIL` : "no FAIL"}, ${results.filter(r => r.level === "WARN").length} WARN`);
process.exit(fails ? 1 : 0);
