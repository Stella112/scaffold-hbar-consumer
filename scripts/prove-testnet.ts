/**
 * yarn prove:testnet
 *
 * Runs the core flows against Hedera testnet through the real sponsor relayer and writes
 * TESTNET_VERIFICATION.md from observed results only. A flow that fails is recorded as FAIL with the error;
 * nothing is filled in by hand.
 */
import { type Address, type Hex, parseAbi, zeroHash } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  ACTION_IDS,
  HBAR,
  HEDERA_TESTNET,
  RESERVED_ACTION_IDS,
  type Receipt,
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
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { mirror, publicClient, walletFor } from "./lib/clients";
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

async function flow(n: number, step: string, fn: () => Promise<Evidence | Evidence[]>) {
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

const ownerSend = async (calls: Parameters<typeof buildOwnerIntent>[0]) => {
  const intent = buildOwnerIntent(calls);
  const sig = await signOwnerIntent(controller, chainId, account, intent);
  return (await sponsor.handle(toSponsorRequest.ownerIntent(chainId, account, intent, sig))).receipt;
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
    resource: { url: "https://hbar.38-49-209-149.sslip.io/api/x402/premium", description: "premium data", mimeType: "application/json" },
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
