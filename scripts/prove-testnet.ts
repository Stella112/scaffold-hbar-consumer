/**
 * yarn prove:testnet
 *
 * Runs the core flows against Hedera testnet through the real sponsor relayer and writes
 * TESTNET_VERIFICATION.md from observed results only. A flow that fails is recorded as FAIL with the error;
 * nothing is filled in by hand.
 */
import { type Address, type Hex, decodeErrorResult, decodeEventLog, encodeFunctionData, parseAbi, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ACTION_IDS,
  HBAR,
  HEDERA_TESTNET,
  RESERVED_ACTION_IDS,
  type Receipt,
  ConsumerAccountReader,
  consumerAccountAbi,
  encodeVaultDeposit,
  longZeroToEntityId,
  tokenLaunchpadAbi,
  buildOwnerIntent,
  buildSessionAction,
  decodeRevertData,
  encodeExecuteOwnerIntent,
  encodePayment,
  encodeSwapToPay,
  exactOutputPath,
  requireDeployment,
  selfCall,
  signOwnerIntent,
  signSessionAction,
  testnetDeployment,
  tinybarsToWeibars,
  toSponsorRequest,
  TransferExecutorClient,
  X402_HBAR_ASSET,
  X402_HEDERA_TESTNET,
  X402_VERSION,
  x402HbarSpendControls,
  resolveX402PayTo,
} from "@sh/sdk";
import { TransferExecutorFacilitator, createTestnetSponsor, loadRelayerConfig, toMirrorTransactionId } from "@sh/relayer";
import { createConsumerMcpServer } from "@sh/mcp";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { AccountCreateTransaction, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { hederaClient, mirror, publicClient, walletFor } from "./lib/clients";
import { hex0x, operatorEnv, parseEnv, roleEnv } from "./lib/env";
import { type Evidence, writeVerification } from "./lib/evidence";

const op = parseEnv(operatorEnv, "prove:testnet");
const roles = parseEnv(roleEnv, "prove:testnet (run `yarn bootstrap --fund` first)");
const factory = requireDeployment("factory");
const tokens = requireDeployment("tokens");
const ss = requireDeployment("saucerswap");
const M = mirror();
const pc = publicClient();
const chainId = HEDERA_TESTNET.chainId;
// A fresh controller per run: proves a key with no Hedera account and no HBAR can create and operate an account.
const controller = privateKeyToAccount(generatePrivateKey());
const agent = privateKeyToAccount(hex0x(roles.AGENT_PRIVATE_KEY));
const operatorWallet = walletFor(op.HEDERA_OPERATOR_KEY);
const { sponsor, auditor } = createTestnetSponsor(loadRelayerConfig(process.env), ".data/prove");
const merchantEvm = (await M.getAccount(roles.MERCHANT_ACCOUNT_ID))!.evm_address as Address;
const unassociatedEvm = (await M.getAccount(roles.UNASSOCIATED_ACCOUNT_ID))!.evm_address as Address;
const WHBAR = tokens.WHBAR!.address;
const USDC = tokens.USDC!.address;
const entries: Evidence[] = [];
const now = () => new Date().toISOString();
const resultQuery = (hash: string) => `${HEDERA_TESTNET.mirrorUrl}/contracts/results/${hash}`;

const quoterAbi = parseAbi([
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const balanceOf = (token: Address, who: Address) =>
  pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

let account: Address;

function fromReceipt(flow: number, step: string, r: Receipt, extra: Partial<Evidence>): Evidence {
  const base = {
    flow,
    step,
    featureStatus: "VERIFIED_TESTNET",
    timestamp: now(),
    actor: `${r.actor} (${r.actorType})`,
    account: r.account,
    contract: r.account,
    asset: null,
    input: "",
    expected: "",
    hcs: r.hcsAudit ? `topic ${r.hcsAudit.topicId} seq ${r.hcsAudit.sequenceNumber}` : null,
  };
  if (r.status === "success") {
    return {
      ...base,
      actual: `SUCCESS, mirror ${r.mirror.status}, fee ${r.networkFeeTinybars} tinybars paid by sponsor ${r.sponsor}`,
      transactionHash: r.transactionHash,
      transactionId: r.transactionId,
      mirrorQuery: resultQuery(r.transactionHash),
      mirrorResult: r.mirror.status === "verified" ? `result ${r.mirror.result} at ${r.mirror.consensusTimestamp}` : r.mirror.status,
      status: r.mirror.status === "verified" ? "PASS" : "FAIL",
      ...extra,
    };
  }
  return {
    ...base,
    actual: `DENIED ${r.reasonCode} by ${r.deniedBy}: ${r.detail}`,
    transactionHash: r.transactionHash,
    transactionId: null,
    mirrorQuery: r.transactionHash ? resultQuery(r.transactionHash) : null,
    mirrorResult: null,
    status: "FAIL",
    ...extra,
  };
}

// PROVE_FLOWS=1,2,10 runs a subset (later flows depend on the account from flow 1 and funds from flow 2).
const only = process.env.PROVE_FLOWS ? new Set(process.env.PROVE_FLOWS.split(",").map(Number)) : null;

async function flow(n: number, step: string, fn: () => Promise<Evidence | Evidence[]>) {
  if (only && !only.has(n)) return;
  console.log(`\n▶ ${n}. ${step}`);
  try {
    const e = await fn();
    for (const x of Array.isArray(e) ? e : [e]) {
      entries.push(x);
      console.log(`  ${x.status}: ${x.actual}`);
    }
  } catch (err) {
    // viem errors keep the useful part (RPC URL, status, node message) in details, not the first line.
    const e = err as Error & { shortMessage?: string; details?: string; status?: number };
    const msg = [e.shortMessage ?? e.message.split("\n")[0], e.status && `HTTP ${e.status}`, e.details]
      .filter(Boolean)
      .join(" — ");
    entries.push({
      flow: n,
      step,
      featureStatus: "EXPERIMENTAL",
      timestamp: now(),
      actor: "—",
      account: account ?? "—",
      contract: null,
      asset: null,
      input: "—",
      expected: "—",
      actual: `ERROR ${msg}`,
      transactionHash: null,
      transactionId: null,
      mirrorQuery: null,
      mirrorResult: null,
      hcs: null,
      status: "FAIL",
    });
    console.log(`  FAIL: ${msg}`);
  }
}

const ownerSend = async (calls: Parameters<typeof buildOwnerIntent>[0], minGas?: bigint) => {
  const intent = buildOwnerIntent(calls);
  const sig = await signOwnerIntent(controller, chainId, account, intent);
  return (await sponsor.handle(toSponsorRequest.ownerIntent(chainId, account, intent, sig, { minGas }))).receipt;
};

const actionSend = async (signer: typeof controller, actionId: Hex, data: Hex) => {
  const a = buildSessionAction(actionId, data);
  const sig = await signSessionAction(signer, chainId, account, a);
  return (await sponsor.handle(toSponsorRequest.sessionAction(chainId, account, a, sig))).receipt;
};

const controllerHbar = async () => (await M.getHbarBalance(controller.address)).tinybars;

// ---------------------------------------------------------------- flows

await flow(1, "ConsumerAccount creation (sponsored)", async () => {
  const before = await M.getHbarBalance(controller.address);
  const r = (await sponsor.handle(toSponsorRequest.createAccount(chainId, controller.address, zeroHash))).receipt;
  account = r.account;
  return fromReceipt(1, "ConsumerAccount creation (sponsored)", r, {
    input: `factory.createAccount(owner=${controller.address}, salt=0x0)`,
    expected: "account deployed by sponsor; controller unchanged",
    asset: null,
    actor: `${controller.address} (controller; Hedera account exists: ${before.exists}, ${before.tinybars} tinybars)`,
  });
});

await flow(2, "Zero-HBAR controller sponsored HBAR payment", async () => {
  // Setup (operator funds the ConsumerAccount, not the controller).
  const fund = await operatorWallet.sendTransaction({ to: account, value: tinybarsToWeibars(500_000_000n) });
  await pc.waitForTransactionReceipt({ hash: fund });
  await M.waitForContractResult(fund).catch(() => null);
  const before = await controllerHbar();
  const merchantBefore = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars;
  const r = await ownerSend([{ target: merchantEvm, value: 10_000_000n, data: "0x" }]);
  const after = await controllerHbar();
  const merchantAfter = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars;
  const e = fromReceipt(2, "Zero-HBAR controller sponsored HBAR payment", r, {
    asset: "HBAR",
    input: `owner intent: pay 0.1 HBAR (10000000 tinybars) to merchant ${roles.MERCHANT_ACCOUNT_ID}; account pre-funded with 5 HBAR by operator (tx ${fund})`,
    expected: "controller balance 0 before and after; merchant +10000000 tinybars",
  });
  e.actual += `; controller tinybars before=${before} after=${after}; merchant delta=${merchantAfter - merchantBefore} (mirror balance snapshot)`;
  if (before !== 0n || after !== 0n) e.status = "FAIL";
  return e;
});

await flow(3, "Direct HTS token payment (WHBAR)", async () => {
  const setup = await ownerSend([
    selfCall.associateToken(account, WHBAR),
    { target: ss.whbar, value: 200_000_000n, data: "0xd0e30db0" }, // WHBAR.deposit() with 2 HBAR
  ]);
  if (setup.status !== "success") throw new Error(`setup (associate + wrap) denied: ${setup.reasonCode}`);
  const before = await balanceOf(WHBAR, merchantEvm);
  const r = await actionSend(controller, ACTION_IDS.payment, encodePayment({ asset: WHBAR, to: merchantEvm, amount: 25_000_000n }));
  const after = await balanceOf(WHBAR, merchantEvm);
  const e = fromReceipt(3, "Direct HTS token payment (WHBAR)", r, {
    asset: `WHBAR ${tokens.WHBAR!.tokenId}`,
    input: `typed payment action 0.25 WHBAR to merchant; setup tx ${setup.transactionHash} (associate + wrap 2 HBAR)`,
    expected: "merchant WHBAR +25000000",
  });
  e.actual += `; merchant WHBAR delta=${after - before}`;
  if (after - before !== 25_000_000n) e.status = "FAIL";
  return e;
});

await flow(4, "SaucerSwap swap-to-pay (WHBAR → exact 0.1 USDC)", async () => {
  const amountOut = 100_000n; // 0.1 USDC (6 decimals)
  const [quotedIn] = (await pc.readContract({
    address: ss.quoter,
    abi: quoterAbi,
    functionName: "quoteExactOutputSingle",
    args: [{ tokenIn: WHBAR, tokenOut: USDC, amount: amountOut, fee: 3000, sqrtPriceLimitX96: 0n }],
  })) as unknown as [bigint];
  const maxIn = (quotedIn * 102n) / 100n; // 2% slippage bound
  const allow = await ownerSend([selfCall.setSwapRouter(account, ss.router, true)]);
  if (allow.status !== "success") throw new Error(`router allowlist denied: ${allow.reasonCode}`);
  const before = await balanceOf(USDC, merchantEvm);
  const r = await actionSend(
    controller,
    ACTION_IDS.swapToPay,
    encodeSwapToPay({
      router: ss.router,
      tokenIn: WHBAR,
      amountInMaximum: maxIn,
      tokenOut: USDC,
      amountOut,
      to: merchantEvm,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 300),
      path: exactOutputPath([USDC, WHBAR], [3000]),
    }),
  );
  const after = await balanceOf(USDC, merchantEvm);
  const e = fromReceipt(4, "SaucerSwap swap-to-pay (WHBAR → exact 0.1 USDC)", r, {
    asset: `in WHBAR ${tokens.WHBAR!.tokenId} → out USDC ${tokens.USDC!.tokenId}`,
    contract: `ConsumerAccount ${account} → SaucerSwap V2 router 0.0.1414040`,
    input: `QuoterV2 exact-output quote ${quotedIn} WHBAR units; amountInMaximum ${maxIn}; amountOut ${amountOut}`,
    expected: "merchant USDC +100000 exactly; account spends ≤ amountInMaximum",
  });
  e.actual += `; merchant USDC delta=${after - before}`;
  if (after - before < amountOut) e.status = "FAIL";
  return e;
});

await flow(5, "HIP-904 airdrop to unassociated recipient", async () => {
  const assocBefore = await M.isAssociated(roles.UNASSOCIATED_ACCOUNT_ID, tokens.WHBAR!.tokenId);
  const r = await actionSend(controller, ACTION_IDS.airdrop, encodePayment({ asset: WHBAR, to: unassociatedEvm, amount: 1_000_000n }));
  await new Promise(res => setTimeout(res, 6_000));
  const pending = await M.getPendingAirdrops(roles.UNASSOCIATED_ACCOUNT_ID);
  const match = pending.find(p => p.token_id === tokens.WHBAR!.tokenId);
  const e = fromReceipt(5, "HIP-904 airdrop to unassociated recipient", r, {
    asset: `WHBAR ${tokens.WHBAR!.tokenId}`,
    input: `typed airdrop action 0.01 WHBAR to ${roles.UNASSOCIATED_ACCOUNT_ID} (associated before: ${assocBefore}, max auto-associations 0)`,
    expected: "pending airdrop recorded for the recipient (demonstrates pending state, not claim)",
  });
  e.mirrorQuery = `${HEDERA_TESTNET.mirrorUrl}/accounts/${roles.UNASSOCIATED_ACCOUNT_ID}/airdrops/pending`;
  e.mirrorResult = match ? `pending: ${match.amount} of ${match.token_id} from ${match.sender_id}` : "no pending airdrop found";
  if (!match || assocBefore) e.status = "FAIL";
  return e;
});

await flow(6, "x402 exact / transferExecutor payment by an agent session", async () => {
  // Facilitator = sponsor account as fee payer; the ConsumerAccount is its own ITransferExecutor.
  const facilitator = new TransferExecutorFacilitator({
    publicClient: pc,
    chainId,
    mirror: M,
    factory,
    feePayerAccountId: roles.SPONSOR_ACCOUNT_ID,
    feePayerKey: hex0x(roles.SPONSOR_PRIVATE_KEY),
    feePayerEvm: privateKeyToAccount(hex0x(roles.SPONSOR_PRIVATE_KEY)).address,
    dataDir: ".data/prove",
    auditor,
  });
  const executorId = await facilitator.admit(account);
  const x402 = new x402Facilitator().register(X402_HEDERA_TESTNET, facilitator);

  // Agent session limited to x402 payments to the merchant, at the address the facilitator resolves payTo to.
  const x402Agent = privateKeyToAccount(generatePrivateKey());
  const merchantPayTo = await resolveX402PayTo(M, roles.MERCHANT_ACCOUNT_ID);
  const grant = await ownerSend([
    selfCall.grantSession(account, {
      key: x402Agent.address,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      perCallCapUsd6: 1_000_000n,
      dailyCapUsd6: 3_000_000n,
      allowedActions: [ACTION_IDS.x402Payment],
      allowedRecipients: [merchantPayTo],
    }),
  ]);
  if (grant.status !== "success") throw new Error(`x402 session grant denied: ${grant.reasonCode}`);

  const requirements = {
    scheme: "exact",
    network: X402_HEDERA_TESTNET,
    asset: X402_HBAR_ASSET,
    amount: "5000000", // 0.05 HBAR
    payTo: roles.MERCHANT_ACCOUNT_ID,
    maxTimeoutSeconds: 120,
    extra: facilitator.getExtra(X402_HEDERA_TESTNET)!,
  } as const;
  const paymentRequired = {
    x402Version: X402_VERSION,
    resource: { url: "https://hbar.getqueryflow.xyz/api/x402/premium", description: "premium data", mimeType: "application/json" },
    accepts: [requirements],
  };
  const client = new x402Client()
    .register(X402_HEDERA_TESTNET, new TransferExecutorClient({ signer: x402Agent, chainId, account, accountId: executorId, mirror: M }))
    .setSpendControls(x402HbarSpendControls(100_000_000n)); // client-side cap: 1 HBAR per payment
  // Wire round trip through the PAYMENT-SIGNATURE header encoding.
  const payload = decodePaymentSignatureHeader(encodePaymentSignatureHeader(await client.createPaymentPayload(paymentRequired)));

  const out: Evidence[] = [];
  const base = (step: string, input: string, expected: string): Evidence => ({
    flow: 6,
    step,
    featureStatus: "VERIFIED_TESTNET",
    timestamp: now(),
    actor: `${x402Agent.address} (session key, x402-payment only)`,
    account,
    contract: executorId,
    asset: "HBAR",
    input,
    expected,
    actual: "",
    transactionHash: null,
    transactionId: null,
    mirrorQuery: null,
    mirrorResult: null,
    hcs: auditor?.topicId ? `topic ${auditor.topicId}: x402 allow/deny decisions audited by the facilitator` : null,
    status: "FAIL",
  });

  const verified = await x402.verify(payload, requirements);
  const merchantBefore = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars;
  const settled = await x402.settle(payload, requirements);
  await new Promise(r => setTimeout(r, 6000));
  const delta = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars - merchantBefore;
  const pay = base(
    "x402 verify + settle (ContractExecuteTransaction → executeTransfer)",
    `PaymentRequired exact/hedera:testnet 0.05 HBAR to ${roles.MERCHANT_ACCOUNT_ID}; executors ${JSON.stringify(requirements.extra.executors)}`,
    "isValid; settled with payTo credited exactly 5000000 tinybars; only payer + fee payer debited",
  );
  pay.transactionId = settled.transaction || null;
  pay.mirrorQuery = settled.transaction
    ? `${HEDERA_TESTNET.mirrorUrl}/transactions/${toMirrorTransactionId(settled.transaction)}`
    : null;
  pay.actual = `verify isValid=${verified.isValid}${verified.invalidReason ? ` (${verified.invalidReason})` : ""}; settle success=${settled.success}${settled.errorReason ? ` (${settled.errorReason}: ${settled.errorMessage ?? ""})` : ""}; merchant delta=${delta}`;
  pay.mirrorResult = settled.success ? "record transfer lists conform (checked by facilitator)" : null;
  pay.status = verified.isValid && settled.success && delta === 5_000_000n ? "PASS" : "FAIL";
  out.push(pay);

  const replay = await x402.settle(payload, requirements);
  const r = base("x402 replay of the same payment", "settle the identical payload again", "rejected; nonce already consumed on chain");
  r.actual = `success=${replay.success} ${replay.errorReason ?? ""}`;
  r.status = !replay.success && replay.errorReason === "simulation_reverted" ? "PASS" : "FAIL";
  out.push(r);

  const tampered = await x402.verify(payload, { ...requirements, amount: "6000000" });
  const t = base("x402 amount tampering", "same signed payload against requirements with amount 6000000", "invalid; signature binds the amount");
  t.actual = `isValid=${tampered.isValid} ${tampered.invalidReason ?? ""}`;
  t.status = !tampered.isValid ? "PASS" : "FAIL";
  out.push(t);
  return out;
});

await flow(7, "AI agent via MCP against the deployed app", async () => {
  const appUrl = process.env.CONSUMER_APP_URL;
  if (!appUrl) throw new Error("CONSUMER_APP_URL not set: flow needs a deployed app (sponsor + x402 endpoints)");
  const mcpAgent = privateKeyToAccount(generatePrivateKey());
  const grant = await ownerSend([
    selfCall.grantSession(account, {
      key: mcpAgent.address,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      perCallCapUsd6: 1_000_000n,
      dailyCapUsd6: 3_000_000n,
      allowedActions: [ACTION_IDS.payment, ACTION_IDS.x402Payment],
      allowedRecipients: [],
    }),
  ]);
  if (grant.status !== "success") throw new Error(`MCP session grant denied: ${grant.reasonCode}`);

  const server = createConsumerMcpServer({ account, agent: mcpAgent, appUrl });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "prove-testnet", version: "0.1.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError === true, out: JSON.parse((r.content as { text: string }[])[0]!.text) as Record<string, any> };
  };
  const base = (step: string, input: string, expected: string): Evidence => ({
    flow: 7,
    step,
    featureStatus: "VERIFIED_TESTNET",
    timestamp: now(),
    actor: `${mcpAgent.address} (session key held by the MCP server)`,
    account,
    contract: null,
    asset: "HBAR",
    input,
    expected,
    actual: "",
    transactionHash: null,
    transactionId: null,
    mirrorQuery: null,
    mirrorResult: null,
    hcs: null,
    status: "FAIL",
  });
  const out: Evidence[] = [];

  const allowance = await call("get_policy");
  const a = base("MCP get_policy", "tool get_policy", "caps $1.00 / $3.00 and a live HBAR price");
  a.actual = JSON.stringify(allowance.out);
  a.status = !allowance.isError && allowance.out.perPaymentCap === "$1.00" && /^\$0\.\d+/.test(String(allowance.out.hbarUsd)) ? "PASS" : "FAIL";
  out.push(a);

  const merchantBefore = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars;
  const pay = await call("create_payment", { to: roles.MERCHANT_ACCOUNT_ID, amount: "0.2", asset: "HBAR" });
  await new Promise(r => setTimeout(r, 6000));
  const delta = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars - merchantBefore;
  const p = base("MCP create_payment (sponsored by the deployed app)", `tool create_payment { to: ${roles.MERCHANT_ACCOUNT_ID}, amount: 0.2 HBAR }`, "success; merchant +20000000 tinybars");
  p.transactionId = pay.out.transactionId ?? null;
  p.actual = `status=${pay.out.status} ${pay.out.reasonCode ?? ""}; merchant delta=${delta}`;
  p.status = pay.out.status === "success" && delta === 20_000_000n ? "PASS" : "FAIL";
  out.push(p);

  const over = await call("create_payment", { to: roles.MERCHANT_ACCOUNT_ID, amount: "50", asset: "HBAR" });
  const o = base("MCP create_payment over the cap", "tool create_payment { amount: 50 HBAR } (≈ $5 > $1 cap)", "denied PER_CALL_CAP_EXCEEDED, reason returned to the model");
  o.actual = `isError=${over.isError} status=${over.out.status} ${over.out.reasonCode ?? ""}`;
  o.status = over.isError && over.out.reasonCode === "PER_CALL_CAP_EXCEEDED" ? "PASS" : "FAIL";
  out.push(o);

  const paid = await call("purchase_x402", { url: `${appUrl.replace(/\/$/, "")}/api/x402/premium`, maxHbar: "0.1" });
  const x = base("MCP purchase_x402 (x402 over HTTP)", "tool purchase_x402 { url: /api/x402/premium }", "402 → paid → 200 with live HBAR/USD data");
  x.transactionId = paid.out.settlement?.transaction ?? null;
  x.mirrorQuery = x.transactionId ? `${HEDERA_TESTNET.mirrorUrl}/transactions/${toMirrorTransactionId(x.transactionId)}` : null;
  x.actual = `status=${paid.out.status} paid=${paid.out.paid} data=${JSON.stringify(paid.out.body).slice(0, 160)}`;
  x.status = paid.out.status === 200 && paid.out.paid === true && typeof paid.out.body?.hbarUsd === "number" ? "PASS" : "FAIL";
  out.push(x);
  await client.close();
  return out;
});

await flow(8, "Agent attacks (session policy red team)", async () => {
  const grant = await ownerSend([
    selfCall.grantSession(account, {
      key: agent.address,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      perCallCapUsd6: 1_000_000n,
      dailyCapUsd6: 3_000_000n,
      allowedActions: [ACTION_IDS.payment, ACTION_IDS.x402Payment],
      allowedRecipients: [merchantEvm],
    }),
  ]);
  if (grant.status !== "success") throw new Error(`grant session denied: ${grant.reasonCode}`);
  const out: Evidence[] = [
    fromReceipt(8, "Owner grants agent session", grant, {
      input: `session ${agent.address}: payment + x402, $1/call, $3/day, recipient ${roles.MERCHANT_ACCOUNT_ID} only, 1h`,
      expected: "SessionGranted",
    }),
  ];
  // Allowed spend, priced by the live Supra feed through the account's oracle.
  const merchantBefore = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars;
  const pay = await actionSend(agent, ACTION_IDS.payment, encodePayment({ asset: HBAR, to: merchantEvm, amount: 50_000_000n }));
  const payEvidence = fromReceipt(8, "Agent pays within caps (Supra-priced)", pay, {
    asset: "HBAR",
    input: "session action: pay 0.5 HBAR to merchant (≈ $0.05 at the live HBAR_USD feed; cap $1/call)",
    expected: "success; spend charged against the session's USD caps",
  });
  if (pay.status === "success") {
    await new Promise(r => setTimeout(r, 6000)); // Mirror Node balance snapshots lag consensus
    const delta = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars - merchantBefore;
    payEvidence.actual += `; merchant delta=${delta}`;
    if (delta !== 50_000_000n) payEvidence.status = "FAIL";
  }
  out.push(payEvidence);

  const attacks: [string, Hex, Hex, string][] = [
    ["exceed the per-call cap", ACTION_IDS.payment, encodePayment({ asset: HBAR, to: merchantEvm, amount: 2_000_000_000n }), "PER_CALL_CAP_EXCEEDED"],
    ["withdraw vault assets", RESERVED_ACTION_IDS.vaultWithdraw, "0x", "WITHDRAW_FORBIDDEN"],
    ["change owner", RESERVED_ACTION_IDS.adminSetOwner, "0x", "PRIVILEGE_ESCALATION"],
    ["unknown action", ACTION_IDS.airdrop, encodePayment({ asset: WHBAR, to: merchantEvm, amount: 1n }), "ACTION_NOT_ALLOWED"],
    ["pay a non-allowlisted recipient", ACTION_IDS.payment, encodePayment({ asset: HBAR, to: unassociatedEvm, amount: 1n }), "RECIPIENT_NOT_ALLOWED"],
  ];
  for (const [label, id, data, expected] of attacks) {
    const r = await actionSend(agent, id, data);
    const e = fromReceipt(8, `Agent attack: ${label}`, r, { input: `session action ${label}`, expected: `denied ${expected}` });
    e.status = r.status === "denied" && r.reasonCode === expected && r.hcsAudit ? "PASS" : "FAIL";
    out.push(e);
  }
  return out;
});

await flow(9, "Raw-call bypass: relayer denial + on-chain revert + HCS record", async () => {
  const intent = buildOwnerIntent([{ target: merchantEvm, value: 100_000_000n, data: "0x" }]);
  const sig = await signOwnerIntent(agent, chainId, account, intent);
  const viaRelayer = (await sponsor.handle(toSponsorRequest.ownerIntent(chainId, account, intent, sig))).receipt;
  // Direct bypass: the operator submits the agent-signed raw call straight to the contract with a fixed gas limit.
  const hash = await operatorWallet.sendTransaction({ to: account, data: encodeExecuteOwnerIntent(intent, sig), gas: 300_000n });
  const rcpt = await pc.waitForTransactionReceipt({ hash });
  const mr = await M.waitForContractResult(hash);
  const decoded = decodeRevertData((mr.error_message ?? undefined) as Hex | undefined);
  const ok = viaRelayer.status === "denied" && viaRelayer.reasonCode === "RAW_CALL_FORBIDDEN" && rcpt.status === "reverted" && decoded.reason === "RAW_CALL_FORBIDDEN" && viaRelayer.hcsAudit;
  return {
    flow: 9,
    step: "Raw-call bypass: relayer denial + on-chain revert + HCS record",
    featureStatus: "VERIFIED_TESTNET",
    timestamp: now(),
    actor: `${agent.address} (session key) signing; operator submitting directly`,
    account,
    contract: account,
    asset: "HBAR",
    input: "agent-signed owner intent paying 1 HBAR (raw call)",
    expected: "relayer denies RAW_CALL_FORBIDDEN and audits to HCS; direct submission reverts on-chain with RAW_CALL_FORBIDDEN",
    actual: `relayer: ${viaRelayer.status === "denied" ? viaRelayer.reasonCode : "NOT DENIED"}; direct tx status ${rcpt.status}, decoded ${decoded.reason}`,
    transactionHash: hash,
    transactionId: null,
    mirrorQuery: resultQuery(hash),
    mirrorResult: `result ${mr.result}, error ${mr.error_message}`,
    hcs: viaRelayer.hcsAudit ? `topic ${viaRelayer.hcsAudit.topicId} seq ${viaRelayer.hcsAudit.sequenceNumber}` : "none",
    status: ok ? "PASS" : "FAIL",
  } satisfies Evidence;
});

await flow(10, "Recurring payment executed by the Hedera Schedule Service", async () => {
  // Scheduled executions are paid by the account itself (HSS charges the scheduling contract), so top it up.
  // ~1.7 HBAR of fees per scheduled instalment (2M gas: payment + scheduling the next through HSS).
  const fund = await operatorWallet.sendTransaction({ to: account, value: tinybarsToWeibars(500_000_000n) });
  await pc.waitForTransactionReceipt({ hash: fund });
  const amount = 1_000_000n; // 0.01 HBAR per instalment
  const merchantBefore = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars;
  const firstAt = BigInt(Math.floor(Date.now() / 1000) + 45);
  const r = await ownerSend([
    selfCall.createSubscription(account, {
      asset: HBAR,
      to: merchantEvm,
      amount,
      intervalSeconds: 60n,
      firstAt,
      count: 2,
    }),
  ]);
  const e = fromReceipt(10, "Recurring payment executed by the Hedera Schedule Service", r, {
    asset: "HBAR",
    input: `owner intent createSubscription: 0.01 HBAR to merchant every 60s × 2, first at ${new Date(Number(firstAt) * 1000).toISOString()}`,
    expected: "HSS executes both instalments with no further transactions from anyone; merchant +2000000 tinybars",
  });
  if (r.status !== "success") return e;

  // Wait for the network to run both scheduled calls (each reschedules the next through HSS).
  const reader = new ConsumerAccountReader(pc, account);
  const deadline = Date.now() + 6 * 60_000;
  let sub = (await reader.subscriptions())[0]!;
  while (sub.remaining > 0 && Date.now() < deadline) {
    await new Promise(res => setTimeout(res, 10_000));
    sub = (await reader.subscriptions())[0]!;
  }
  await new Promise(res => setTimeout(res, 6000));
  const delta = (await M.getHbarBalance(roles.MERCHANT_ACCOUNT_ID)).tinybars - merchantBefore;
  // The account's own SubscriptionScheduled events name every HSS schedule it created; check each on Mirror Node.
  const scheduledEvent = parseAbi(["event SubscriptionScheduled(uint256 indexed id, address schedule, uint64 at)"]);
  const logs = await M.get<{ logs: { data: Hex; topics: Hex[] }[] }>(`/contracts/${account}/results/logs?order=asc&limit=50`);
  const scheduleIds = logs.logs.flatMap(l => {
    try {
      const ev = decodeEventLog({ abi: scheduledEvent, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return [longZeroToEntityId(ev.args.schedule) ?? ev.args.schedule];
    } catch {
      return [];
    }
  });
  const schedules = await Promise.all(
    scheduleIds.map(id => M.get<{ schedule_id: string; executed_timestamp: string | null; payer_account_id: string }>(`/schedules/${id}`)),
  );
  const executed = schedules.filter(s => s.executed_timestamp);
  e.mirrorQuery = scheduleIds.map(id => `${HEDERA_TESTNET.mirrorUrl}/schedules/${id}`).join(" ");
  e.mirrorResult = `${schedules.length} HSS schedules created by the account (SubscriptionScheduled events), ${executed.length} executed: ${executed.map(s => `${s.schedule_id} @${s.executed_timestamp} payer ${s.payer_account_id}`).join(", ")}`;
  e.actual += `; remaining=${sub.remaining}; merchant delta=${delta}`;
  e.status = sub.remaining === 0 && delta === 2n * amount && executed.length >= 2 ? "PASS" : "FAIL";
  return e;
});

await flow(11, "Savings vault: agent deposits within caps, can never withdraw or move shares", async () => {
  const vault = requireDeployment("vaults").WHBAR!.address;
  const vaultAbi = parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function maxWithdraw(address) view returns (uint256)",
    "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  ]);
  const saver = privateKeyToAccount(generatePrivateKey());
  const setup = await ownerSend([
    selfCall.setVault(account, vault, true),
    selfCall.grantSession(account, {
      key: saver.address,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
      perCallCapUsd6: 1_000_000n,
      dailyCapUsd6: 3_000_000n,
      allowedActions: [ACTION_IDS.vaultDeposit, ACTION_IDS.payment],
      allowedRecipients: [],
    }),
  ]);
  if (setup.status !== "success") throw new Error(`vault setup denied: ${setup.reasonCode}`);
  const out: Evidence[] = [];

  const whbarBefore = await balanceOf(WHBAR, account);
  const dep = await actionSend(saver, ACTION_IDS.vaultDeposit, encodeVaultDeposit({ vault, assets: 50_000_000n }));
  const shares = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] });
  const d = fromReceipt(11, "Agent deposits 0.5 WHBAR into the savings vault", dep, {
    asset: "WHBAR",
    contract: requireDeployment("vaults").WHBAR!.contractId ?? vault,
    input: "session action vault-deposit { vault: Savings WHBAR, assets: 0.5 WHBAR } (≈ $0.05, cap $1)",
    expected: "success; shares minted to the account; WHBAR -0.5",
  });
  const spent = whbarBefore - (await balanceOf(WHBAR, account));
  d.actual += `; account WHBAR delta=-${spent}; vault shares=${shares}`;
  if (dep.status === "success" && (spent !== 50_000_000n || shares === 0n)) d.status = "FAIL";
  out.push(d);

  for (const [label, id, data, expected] of [
    ["pay vault shares to itself", ACTION_IDS.payment, encodePayment({ asset: vault, to: saver.address, amount: shares }), "WITHDRAW_FORBIDDEN"],
    ["withdraw from the vault", RESERVED_ACTION_IDS.vaultWithdraw, encodeVaultDeposit({ vault, assets: 1n }), "WITHDRAW_FORBIDDEN"],
  ] as [string, Hex, Hex, string][]) {
    const r = await actionSend(saver, id, data);
    const e = fromReceipt(11, `Agent attack: ${label}`, r, { input: `session action ${label}`, expected: `denied ${expected}` });
    e.status = r.status === "denied" && r.reasonCode === expected && r.hcsAudit ? "PASS" : "FAIL";
    out.push(e);
  }

  const before = await balanceOf(WHBAR, account);
  const redeem = await ownerSend([
    { target: vault, value: 0n, data: encodeFunctionData({ abi: vaultAbi, functionName: "redeem", args: [shares, account, account] }) },
  ]);
  const back = (await balanceOf(WHBAR, account)) - before;
  const o = fromReceipt(11, "Owner redeems all shares", redeem, {
    asset: "WHBAR",
    input: `owner intent vault.redeem(${shares} shares)`,
    expected: "success; 0.5 WHBAR back to the account",
  });
  o.actual += `; account WHBAR delta=+${back}`;
  if (redeem.status === "success" && back !== 50_000_000n) o.status = "FAIL";
  out.push(o);
  return out;
});

await flow(12, "Token launchpad: bonding curve, one-time graduation into SaucerSwap, airdropped claims", async () => {
  const pad = requireDeployment("launchpad");
  const padAbi = tokenLaunchpadAbi;
  // The account pays the HTS token-creation fee from its own HBAR; unspent fee comes back.
  const fund = await operatorWallet.sendTransaction({ to: account, value: tinybarsToWeibars(4_000_000_000n) });
  await pc.waitForTransactionReceipt({ hash: fund });
  // Curve 0.01 → 0.03 HBAR over 600,000 tokens; graduate at 22 HBAR (covers the ~$2 SaucerSwap pool fee).
  const params = {
    name: "Scaffold Demo",
    symbol: "SDEMO",
    decimals: 2,
    supply: 1_000_000_00n,
    curveSupply: 600_000_00n,
    startPrice: 1_000_000n,
    endPrice: 3_000_000n,
    target: 2_200_000_000n,
    creatorFeeBps: 500,
    duration: 3600n,
  };
  const out: Evidence[] = [];
  const accountHbar0 = (await M.getHbarBalance(account)).tinybars;
  const launch = await ownerSend([
    { target: pad.address, value: 3_000_000_000n, data: encodeFunctionData({ abi: padAbi, functionName: "launch", args: [params] }) },
  ]);
  const id = (await pc.readContract({ address: pad.address, abi: padAbi, functionName: "launchCount" })) - 1n;
  const info = await pc.readContract({ address: pad.address, abi: padAbi, functionName: "launches", args: [id] });
  const tokenId = longZeroToEntityId(info.token) ?? info.token;
  await new Promise(r => setTimeout(r, 6000));
  const token = await M.get<{ supply_type: string; max_supply: string; total_supply: string; admin_key: unknown; supply_key: unknown; freeze_key: unknown; treasury_account_id: string; name: string }>(`/tokens/${tokenId}`);
  const feeSpent = accountHbar0 - (await M.getHbarBalance(account)).tinybars;
  const l = fromReceipt(12, "Account launches an immutable fixed-supply HTS token", launch, {
    asset: "HBAR",
    contract: pad.contractId ?? pad.address,
    input: "owner intent launchpad.launch{30 HBAR} SDEMO: 1,000,000 supply, 600,000 on a 0.01→0.03 HBAR curve, target 22 HBAR, 5% creator fee",
    expected: "token created by HTS with no admin/supply/freeze keys, FINITE supply, launchpad treasury; unspent fee refunded",
  });
  l.mirrorQuery = `${HEDERA_TESTNET.mirrorUrl}/tokens/${tokenId}`;
  l.mirrorResult = `${token.name} ${tokenId}: ${token.supply_type} max ${token.max_supply} total ${token.total_supply}, treasury ${token.treasury_account_id}, admin_key ${token.admin_key ? "set" : "none"}, supply_key ${token.supply_key ? "set" : "none"}, freeze_key ${token.freeze_key ? "set" : "none"}; account HBAR spent ${feeSpent} of 3000000000 sent`;
  if (launch.status === "success" && (token.supply_type !== "FINITE" || token.admin_key || token.supply_key || token.freeze_key || feeSpent >= 3_000_000_000n)) l.status = "FAIL";
  out.push(l);
  if (launch.status !== "success") return out;

  // Operator (an ordinary Hedera account) buys 2,200 SDEMO along the curve, reaching the 22 HBAR target.
  const buyUnits = 2_200_00n;
  const cost = await pc.readContract({ address: pad.address, abi: padAbi, functionName: "quote", args: [id, buyUnits] });
  const priceBefore = await pc.readContract({ address: pad.address, abi: padAbi, functionName: "currentPrice", args: [id] });
  const buyHash = await operatorWallet.writeContract({ address: pad.address, abi: padAbi, functionName: "buy", args: [id, buyUnits], value: tinybarsToWeibars(cost), chain: operatorWallet.chain, account: operatorWallet.account! });
  const buyRcpt = await pc.waitForTransactionReceipt({ hash: buyHash });
  // The relay estimates and simulates against Mirror Node state, which lags consensus: wait until the buy is indexed.
  await M.waitForContractResult(buyHash).catch(() => null);
  const priceAfter = await pc.readContract({ address: pad.address, abi: padAbi, functionName: "currentPrice", args: [id] });
  const b: Evidence = { ...l, step: "Operator buys 2,200 SDEMO along the curve", actor: `${op.HEDERA_OPERATOR_ID} (EOA buyer)`, input: `buy(${id}, ${buyUnits} units) value ${cost} tinybars`, expected: "success; price rises; raise ≥ 22 HBAR target", transactionHash: buyHash, transactionId: null, mirrorQuery: resultQuery(buyHash), mirrorResult: null, hcs: null, actual: `status=${buyRcpt.status}; cost=${cost}; price ${priceBefore} → ${priceAfter} tinybars/token`, status: buyRcpt.status === "success" && priceAfter > priceBefore && cost >= params.target ? "PASS" : "FAIL", timestamp: now() };
  out.push(b);

  const creatorBefore = (await M.getHbarBalance(account)).tinybars;
  // Creating the pool and minting liquidity through SaucerSwap is HTS-heavy; give it the router's recommended gas.
  const gradHash = await operatorWallet.writeContract({ address: pad.address, abi: padAbi, functionName: "graduate", args: [id], gas: 4_000_000n, chain: operatorWallet.chain, account: operatorWallet.account! });
  const gradRcpt = await pc.waitForTransactionReceipt({ hash: gradHash });
  await M.waitForContractResult(gradHash).catch(() => null);
  await new Promise(r => setTimeout(r, 6000));
  const creatorGain = (await M.getHbarBalance(account)).tinybars - creatorBefore;
  // The relay drops revert data, so ask Mirror Node's simulator and decode the error name.
  const sim = await fetch(`${HEDERA_TESTNET.mirrorUrl}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: operatorWallet.account!.address, to: pad.address, estimate: false, data: encodeFunctionData({ abi: padAbi, functionName: "graduate", args: [id] }) }),
  }).then(r => r.json() as Promise<{ result?: Hex; _status?: { messages?: { data?: Hex }[] } }>);
  const revertData = sim._status?.messages?.[0]?.data;
  let second = sim.result ? "no revert" : "reverted";
  if (revertData && revertData !== "0x") {
    try {
      second = decodeErrorResult({ abi: padAbi, data: revertData }).errorName;
    } catch {
      second = revertData;
    }
  }
  const after = await pc.readContract({ address: pad.address, abi: padAbi, functionName: "launches", args: [id] });
  const pairAbi = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)", "function token0() view returns (address)"]);
  const reserves = after.pair !== "0x0000000000000000000000000000000000000000"
    ? await pc.readContract({ address: after.pair, abi: pairAbi, functionName: "getReserves" }).catch(() => null)
    : null;
  const expectedFee = (cost * 500n) / 10_000n;
  const g: Evidence = { ...b, step: "Graduation seeds a SaucerSwap V1 pool once and pays the creator fee", input: `graduate(${id}) twice`, expected: "pool created with HBAR + SDEMO reserves, LP locked in the launchpad, creator +5% once; second graduate reverts AlreadyGraduated", transactionHash: gradHash, mirrorQuery: resultQuery(gradHash), mirrorResult: `pool ${longZeroToEntityId(after.pair) ?? after.pair}: reserves ${reserves ? `${reserves[0]} / ${reserves[1]}` : "unreadable"}; pool tokens ${after.poolTokens}`, actual: `first status=${gradRcpt.status}, creator delta=${creatorGain} (5% of raise = ${expectedFee}); second: ${second}`, status: gradRcpt.status === "success" && after.graduated && reserves !== null && reserves[0] > 0n && reserves[1] > 0n && creatorGain >= expectedFee && /AlreadyGraduated/.test(second) ? "PASS" : "FAIL", timestamp: now() };
  out.push(g);

  // Contract-initiated airdrops are paid from the launchpad's balance, so the claimer funds the fee (refunded if unspent).
  // eth_estimateGas cannot model HIP-904 fees, so the gas limit is explicit.
  const claimHash = await operatorWallet.writeContract({ address: pad.address, abi: padAbi, functionName: "claim", args: [id], value: tinybarsToWeibars(200_000_000n), gas: 1_500_000n, chain: operatorWallet.chain, account: operatorWallet.account! });
  const claimRcpt = await pc.waitForTransactionReceipt({ hash: claimHash });
  await new Promise(r => setTimeout(r, 6000));
  const opBal = await M.getTokenBalance(op.HEDERA_OPERATOR_ID, tokenId);
  const pending = (await M.getPendingAirdrops(op.HEDERA_OPERATOR_ID)).filter(a => a.token_id === tokenId);
  const c: Evidence = { ...b, step: "Buyer claims via HIP-904 airdrop", input: `claim(${id})`, expected: `${buyUnits} units delivered or pending (claimable) for the buyer`, transactionHash: claimHash, mirrorQuery: `${HEDERA_TESTNET.mirrorUrl}/accounts/${op.HEDERA_OPERATOR_ID}/airdrops/pending`, actual: `status=${claimRcpt.status}; balance=${opBal ?? 0}; pending=${pending.map(p => p.amount).join(",") || "none"}`, status: claimRcpt.status === "success" && (opBal === buyUnits || pending.some(p => BigInt(p.amount) === buyUnits)) ? "PASS" : "FAIL", timestamp: now() };
  out.push(c);

  // Association and HIP-904 fees are charged as gas inside the call; eth_estimateGas misses them, so ask for a floor.
  const creatorClaim = await ownerSend(
    [
      selfCall.associateToken(account, info.token),
      { target: pad.address, value: 200_000_000n, data: encodeFunctionData({ abi: padAbi, functionName: "claim", args: [id] }) },
    ],
    2_500_000n,
  );
  const accountTokens = await balanceOf(info.token, account);
  const cc = fromReceipt(12, "Creator associates and claims unsold + retained supply", creatorClaim, {
    asset: "SDEMO",
    input: "owner intent [associateToken(SDEMO), launchpad.claim]",
    expected: "account receives supply − sold − pool tokens (unsold curve + unused reserve)",
  });
  const creatorShare = params.supply - buyUnits - after.poolTokens;
  cc.actual += `; account SDEMO=${accountTokens} (expected ${creatorShare})`;
  if (creatorClaim.status === "success" && accountTokens !== creatorShare) cc.status = "FAIL";
  out.push(cc);
  return out;
});

await flow(13, "Agent airdrop fees count against its USD caps", async () => {
  // HIP-904 airdrops from a contract are paid from the contract's own HBAR; the account prices that fee and
  // charges it to the session, so an agent cannot spend HBAR on fees beyond its limits.
  const grantAirdropper = async (capUsd6: bigint) => {
    const key = privateKeyToAccount(generatePrivateKey());
    const g = await ownerSend([
      selfCall.grantSession(account, {
        key: key.address,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
        perCallCapUsd6: capUsd6,
        dailyCapUsd6: capUsd6 * 3n,
        allowedActions: [ACTION_IDS.airdrop],
        allowedRecipients: [],
      }),
    ]);
    if (g.status !== "success") throw new Error(`airdrop session grant denied: ${g.reasonCode}`);
    return key;
  };
  const reader = new ConsumerAccountReader(pc, account);
  const out: Evidence[] = [];

  const agentA = await grantAirdropper(1_000_000n); // $1 per call
  const hbarBefore = (await M.getHbarBalance(account)).tinybars;
  const ok = await actionSend(agentA, ACTION_IDS.airdrop, encodePayment({ asset: WHBAR, to: unassociatedEvm, amount: 1_000n }));
  await new Promise(r => setTimeout(r, 6000));
  const feePaid = hbarBefore - (await M.getHbarBalance(account)).tinybars;
  const spent = (await reader.session(agentA.address)).spentTodayUsd6;
  const feeEvent = parseAbi(["event SessionFeeCharged(address indexed key, uint256 tinybars, uint256 usd6)"]);
  const logs = await M.get<{ logs: { data: Hex; topics: Hex[] }[] }>(`/contracts/${account}/results/logs?order=desc&limit=10`);
  const charged = logs.logs.flatMap(l => {
    try {
      const ev = decodeEventLog({ abi: feeEvent, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      return ev.args.key.toLowerCase() === agentA.address.toLowerCase() ? [ev.args] : [];
    } catch {
      return [];
    }
  });
  const a = fromReceipt(13, "Agent airdrop: HIP-904 fee charged to the session", ok, {
    asset: "WHBAR",
    input: "session airdrop 0.00001 WHBAR to the unassociated account (cap $1/call)",
    expected: "success; SessionFeeCharged with the HBAR fee the account paid; session spend includes it",
  });
  a.actual += `; account HBAR fee=${feePaid}; SessionFeeCharged=${charged.map(c => `${c.tinybars} tinybars / ${c.usd6} usd6`).join(",") || "none"}; session spentToday=${spent} usd6`;
  if (ok.status === "success" && (charged.length !== 1 || charged[0]!.tinybars === 0n || spent < charged[0]!.usd6)) a.status = "FAIL";
  out.push(a);

  const agentB = await grantAirdropper(50_000n); // $0.05 per call: the fee alone (~$0.10) exceeds it
  const denied = await actionSend(agentB, ACTION_IDS.airdrop, encodePayment({ asset: WHBAR, to: unassociatedEvm, amount: 1_000n }));
  const b = fromReceipt(13, "Agent airdrop whose fee exceeds the cap is denied", denied, {
    asset: "WHBAR",
    input: "session airdrop 0.00001 WHBAR (token value ≈ $0) with a $0.05 per-call cap",
    expected: "denied PER_CALL_CAP_EXCEEDED: the fee alone exceeds the cap",
  });
  b.status = denied.status === "denied" && denied.reasonCode === "PER_CALL_CAP_EXCEEDED" ? "PASS" : "FAIL";
  out.push(b);
  return out;
});

await flow(14, "HIP-904 pending airdrop claimed by the recipient", async () => {
  // A fresh ordinary Hedera account with no auto-association slots, so the airdrop must wait for its claim.
  const recipientKey = generatePrivateKey();
  const hClient = hederaClient(op.HEDERA_OPERATOR_ID, op.HEDERA_OPERATOR_KEY);
  let recipientId: string;
  try {
    const created = await new AccountCreateTransaction()
      .setECDSAKeyWithAlias(PrivateKey.fromStringECDSA(recipientKey.slice(2)).publicKey)
      .setInitialBalance(new Hbar(3))
      .setMaxAutomaticTokenAssociations(0)
      .execute(hClient);
    recipientId = (await created.getReceipt(hClient)).accountId!.toString();
  } finally {
    hClient.close();
  }
  const recipient = privateKeyToAccount(recipientKey);
  await M.waitForAccount(recipientId);

  const amount = 2_000_000n; // 0.02 WHBAR
  const sent = await actionSend(controller, ACTION_IDS.airdrop, encodePayment({ asset: WHBAR, to: recipient.address, amount }));
  await new Promise(r => setTimeout(r, 6000));
  const pendingBefore = (await M.getPendingAirdrops(recipientId)).filter(a => a.token_id === tokens.WHBAR!.tokenId);
  const out: Evidence[] = [];
  const s = fromReceipt(14, "Account airdrops WHBAR to an unassociated recipient", sent, {
    asset: `WHBAR ${tokens.WHBAR!.tokenId}`,
    input: `typed airdrop 0.02 WHBAR to fresh account ${recipientId} (max auto-associations 0)`,
    expected: "success; pending airdrop recorded for the recipient",
  });
  s.mirrorQuery = `${HEDERA_TESTNET.mirrorUrl}/accounts/${recipientId}/airdrops/pending`;
  s.mirrorResult = `pending: ${pendingBefore.map(p => `${p.amount} from ${p.sender_id}`).join(", ") || "none"}`;
  if (sent.status === "success" && !pendingBefore.some(p => BigInt(p.amount) === amount)) s.status = "FAIL";
  out.push(s);
  if (sent.status !== "success") return out;

  // The recipient claims with its own key through the HTS system contract, exactly as the app's Claim page does.
  const claimAbi = parseAbi([
    "struct PendingAirdrop { address sender; address receiver; address token; int64 serial; }",
    "function claimAirdrops(PendingAirdrop[] pendingAirdrops) returns (int64 responseCode)",
  ]);
  const recipientWallet = walletFor(recipientKey);
  const claimHash = await recipientWallet.writeContract({
    address: "0x0000000000000000000000000000000000000167",
    abi: claimAbi,
    functionName: "claimAirdrops",
    args: [[{ sender: account, receiver: recipient.address, token: WHBAR, serial: 0n }]],
    gas: 1_500_000n,
    chain: recipientWallet.chain,
    account: recipientWallet.account!,
  });
  const claimRcpt = await pc.waitForTransactionReceipt({ hash: claimHash });
  await M.waitForContractResult(claimHash).catch(() => null);
  await new Promise(r => setTimeout(r, 6000));
  const pendingAfter = (await M.getPendingAirdrops(recipientId)).filter(a => a.token_id === tokens.WHBAR!.tokenId);
  const balance = await M.getTokenBalance(recipientId, tokens.WHBAR!.tokenId);
  out.push({
    ...s,
    step: "Recipient claims the pending airdrop (HTS claimAirdrops from its own key)",
    actor: `${recipientId} (${recipient.address}, the recipient)`,
    input: `EVM tx from the recipient to 0x167 claimAirdrops([{sender: account, receiver: recipient, token: WHBAR}])`,
    expected: "pending airdrop gone; recipient WHBAR balance = 2000000",
    actual: `tx status=${claimRcpt.status}; pending after=${pendingAfter.length}; recipient WHBAR=${balance ?? 0}`,
    transactionHash: claimHash,
    transactionId: null,
    mirrorQuery: resultQuery(claimHash),
    mirrorResult: null,
    hcs: null,
    status: claimRcpt.status === "success" && pendingAfter.length === 0 && balance === amount ? "PASS" : "FAIL",
    timestamp: now(),
  });
  return out;
});

await flow(15, "Guardian recovery: two guardians, timelock, new owner takes over", async () => {
  // Guardians are other ConsumerAccounts: they act through sponsored owner intents and need no HBAR.
  const makeGuardian = async () => {
    const key = privateKeyToAccount(generatePrivateKey());
    const r = (await sponsor.handle(toSponsorRequest.createAccount(chainId, key.address, zeroHash))).receipt;
    if (r.status !== "success") throw new Error(`guardian account creation denied: ${r.reasonCode}`);
    return { key, account: r.account as Address };
  };
  const guardianCall = async (g: { key: ReturnType<typeof privateKeyToAccount>; account: Address }, data: Hex) => {
    const intent = buildOwnerIntent([{ target: account, value: 0n, data }]);
    const sig = await signOwnerIntent(g.key, chainId, g.account, intent);
    return (await sponsor.handle(toSponsorRequest.ownerIntent(chainId, g.account, intent, sig))).receipt;
  };
  const [g1, g2] = [await makeGuardian(), await makeGuardian()];
  const delay = 300n; // MIN_RECOVERY_DELAY
  const setup = await ownerSend([selfCall.setGuardians(account, [g1.account, g2.account], 2, delay)]);
  const out: Evidence[] = [
    fromReceipt(15, "Owner sets two guardians, threshold 2, 5-minute timelock", setup, {
      input: `setGuardians([${g1.account}, ${g2.account}], 2, 300s)`,
      expected: "GuardiansUpdated",
    }),
  ];
  if (setup.status !== "success") return out;

  const newOwner = privateKeyToAccount(generatePrivateKey());
  const propose = await guardianCall(g1, encodeFunctionData({ abi: consumerAccountAbi, functionName: "proposeRecovery", args: [newOwner.address] }));
  out.push(
    fromReceipt(15, "Guardian 1 proposes the new owner key", propose, {
      actor: `${g1.account} (guardian ConsumerAccount, 0 HBAR owner)`,
      input: `guardian owner intent → account.proposeRecovery(${newOwner.address})`,
      expected: "RecoveryProposed (1 of 2 approvals)",
    }),
  );
  const approve = await guardianCall(g2, encodeFunctionData({ abi: consumerAccountAbi, functionName: "approveRecovery", args: [] }));
  out.push(
    fromReceipt(15, "Guardian 2 approves: threshold reached, timelock starts", approve, {
      actor: `${g2.account} (guardian ConsumerAccount)`,
      input: "guardian owner intent → account.approveRecovery()",
      expected: "RecoveryReady",
    }),
  );
  if (propose.status !== "success" || approve.status !== "success") return out;

  // Too early: executeRecovery must revert before the timelock ends.
  const execData = encodeFunctionData({ abi: consumerAccountAbi, functionName: "executeRecovery", args: [] });
  const early = await fetch(`${HEDERA_TESTNET.mirrorUrl}/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: operatorWallet.account!.address, to: account, data: execData, estimate: false }),
  }).then(r => r.json() as Promise<{ _status?: { messages?: { data?: Hex }[] } }>);
  const earlyData = early._status?.messages?.[0]?.data;
  const earlyReason = earlyData && earlyData !== "0x" ? decodeRevertData(earlyData).errorName : "no revert";

  await new Promise(r => setTimeout(r, Number(delay + 20n) * 1000));
  const execHash = await operatorWallet.sendTransaction({ to: account, data: execData, gas: 300_000n, chain: operatorWallet.chain, account: operatorWallet.account! });
  const execRcpt = await pc.waitForTransactionReceipt({ hash: execHash });
  await M.waitForContractResult(execHash).catch(() => null);
  const ownerNow = await pc.readContract({ address: account, abi: consumerAccountAbi, functionName: "owner" });

  // The old controller is locked out; the recovered key can pay (sponsored).
  const oldTry = await ownerSend([{ target: merchantEvm, value: 1_000_000n, data: "0x" }]);
  const intent = buildOwnerIntent([{ target: merchantEvm, value: 1_000_000n, data: "0x" }]);
  const newTry = (await sponsor.handle(
    toSponsorRequest.ownerIntent(chainId, account, intent, await signOwnerIntent(newOwner, chainId, account, intent)),
  )).receipt;
  out.push({
    ...out[0]!,
    step: "Timelock, execution, and the keys afterwards",
    actor: "anyone (executeRecovery is permissionless once ready)",
    input: `executeRecovery() early (simulated) and after ${delay}s; then old key and new key each try to pay 0.01 HBAR`,
    expected: "early: RecoveryNotReady; then owner = new key; old key SIGNATURE_INVALID; new key pays",
    actual: `early: ${earlyReason}; execute status=${execRcpt.status}; owner=${ownerNow}; old key → ${oldTry.status} ${oldTry.status === "denied" ? oldTry.reasonCode : ""}; new key → ${newTry.status}`,
    transactionHash: execHash,
    transactionId: null,
    mirrorQuery: resultQuery(execHash),
    mirrorResult: null,
    hcs: null,
    status:
      earlyReason === "RecoveryNotReady" &&
      execRcpt.status === "success" &&
      ownerNow.toLowerCase() === newOwner.address.toLowerCase() &&
      oldTry.status === "denied" &&
      newTry.status === "success"
        ? "PASS"
        : "FAIL",
    timestamp: now(),
  });
  return out;
});

const header = [
  `Run: ${now()}`,
  `Factory: ${testnetDeployment.factoryContractId} (${factory})`,
  `ConsumerAccount: ${account!}`,
  `Controller (signer only, no Hedera account expected): ${controller.address}`,
  `Sponsor: ${roles.SPONSOR_ACCOUNT_ID}`,
  `HCS audit topic: ${auditor?.topicId ?? "not configured"}`,
].join("  \n");
const file = writeVerification(entries, header);
console.log(`\nwrote ${file}`);
process.exit(entries.some(e => e.status !== "PASS") ? 1 : 0);
