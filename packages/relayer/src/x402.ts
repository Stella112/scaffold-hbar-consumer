import fs from "node:fs";
import path from "node:path";
import { Client, ContractExecuteTransaction, ContractId, PrivateKey } from "@hiero-ledger/sdk";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { type Address, type Hex, type PublicClient, getAddress, isHex, keccak256, recoverTypedDataAddress } from "viem";
import {
  type MirrorClient,
  type MirrorTransaction,
  TRANSFER_AUTHORIZATION_TYPES,
  X402_HEDERA_TESTNET,
  X402_HBAR_ASSET,
  X402_SCHEME,
  X402_TRANSFER_EXECUTOR,
  consumerAccountAbi,
  consumerAccountDomain,
  consumerAccountFactoryAbi,
  decodeTransferAuthorization,
  encodeExecuteTransfer,
  isEntityId,
  x402AssetToAddress,
  resolveX402PayTo,
} from "@sh/sdk";
import type { Auditor } from "./audit";

const GAS_HEADROOM_NUM = 13n;
const GAS_HEADROOM_DEN = 10n;
const MIN_GAS = 150_000n;
const DEFAULT_MAX_GAS = 1_000_000n;
const SALT_ZERO = `0x${"0".repeat(64)}` as Hex;

export type TransferExecutorFacilitatorDeps = {
  publicClient: PublicClient;
  chainId: number;
  mirror: MirrorClient;
  /** Only ConsumerAccounts deployed by this factory (salt 0) are admitted as executors. */
  factory: Address;
  /** Fee payer: submits ContractExecuteTransaction and pays the network fee. */
  feePayerAccountId: string;
  feePayerKey: Hex;
  feePayerEvm: Address;
  /** Directory for the admitted-executor list; null keeps it in memory (tests). */
  dataDir: string | null;
  auditor?: Auditor | null;
  maxGas?: bigint;
  /** Mirror Node indexing wait for the settlement record. */
  recordTimeoutMs?: number;
  now?: () => number;
};

type Prepared = {
  payer: string;
  executor: string;
  from: Address;
  asset: Address;
  to: Address;
  amount: bigint;
  data: Hex;
  gas: bigint;
  signer: Address;
  actorType: "owner" | "session";
};

type Check<T> = { ok: true; value: T } | { ok: false; reason: string; message: string };
const fail = (reason: string, message: string): { ok: false; reason: string; message: string } => ({ ok: false, reason, message });

/**
 * x402 `exact` facilitator for Hedera, `transferExecutor` method (scheme_exact_hedera.md, phases 3–4).
 * Register with `new x402Facilitator().register("hedera:testnet", facilitator)`.
 */
export class TransferExecutorFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = X402_SCHEME;
  readonly caipFamily = "hedera:*";
  private readonly admitted = new Set<string>();
  private readonly file: string | null;

  constructor(private readonly d: TransferExecutorFacilitatorDeps) {
    this.file = d.dataDir ? path.join(d.dataDir, "x402-executors.json") : null;
    if (this.file && fs.existsSync(this.file)) {
      for (const id of JSON.parse(fs.readFileSync(this.file, "utf8")) as string[]) this.admitted.add(id);
    }
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    if (network !== X402_HEDERA_TESTNET) return undefined;
    return { assetTransferMethod: X402_TRANSFER_EXECUTOR, executors: [...this.admitted] };
  }

  getSigners(network: string): string[] {
    return network === X402_HEDERA_TESTNET ? [this.d.feePayerAccountId] : [];
  }

  executors(): string[] {
    return [...this.admitted];
  }

  /** Admits a ConsumerAccount deployed by this facilitator's factory. Returns its Hedera contract id. */
  async admit(accountIdOrEvm: string): Promise<string> {
    const c = await this.d.mirror.getContract(accountIdOrEvm);
    if (!c) throw new Error(`executor ${accountIdOrEvm} is not a contract on Mirror Node`);
    const account = getAddress(c.evm_address);
    let owner: Address;
    try {
      owner = await this.d.publicClient.readContract({ address: account, abi: consumerAccountAbi, functionName: "owner" });
    } catch {
      throw new Error(`executor ${c.contract_id} is not a ConsumerAccount`);
    }
    const expected = await this.d.publicClient.readContract({
      address: this.d.factory,
      abi: consumerAccountFactoryAbi,
      functionName: "getAddress",
      args: [owner, SALT_ZERO],
    });
    if (getAddress(expected) !== account) throw new Error(`executor ${c.contract_id} was not deployed by the admitted factory`);
    if (!this.admitted.has(c.contract_id)) {
      this.admitted.add(c.contract_id);
      if (this.file) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify([...this.admitted], null, 2));
      }
    }
    return c.contract_id;
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const p = await this.prepare(payload, requirements);
    if (!p.ok) {
      await this.audit(payload, requirements, null, false, p.reason, null);
      return { isValid: false, invalidReason: p.reason, invalidMessage: p.message, payer: payerOf(payload) };
    }
    return { isValid: true, payer: p.value.payer };
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const p = await this.prepare(payload, requirements);
    if (!p.ok) {
      await this.audit(payload, requirements, null, false, p.reason, null);
      return { success: false, errorReason: p.reason, errorMessage: p.message, transaction: "", network, payer: payerOf(payload) };
    }
    const v = p.value;
    // Re-confirm admission immediately before signing (spec phase 4.1).
    if (!this.admitted.has(v.executor)) {
      return { success: false, errorReason: "invalid_exact_hedera_executor_not_admitted", transaction: "", network, payer: v.payer };
    }

    const client = Client.forTestnet().setOperator(
      this.d.feePayerAccountId,
      PrivateKey.fromStringECDSA(this.d.feePayerKey.replace(/^0x/, "")),
    );
    let transactionId: string;
    try {
      const resp = await new ContractExecuteTransaction()
        .setContractId(ContractId.fromString(v.executor))
        .setGas(Number(v.gas))
        .setFunctionParameters(Buffer.from(v.data.slice(2), "hex"))
        .execute(client);
      transactionId = resp.transactionId.toString();
      try {
        await resp.getReceipt(client);
      } catch (e) {
        await this.audit(payload, requirements, v, false, "settlement_reverted", transactionId);
        return {
          success: false,
          errorReason: "settlement_reverted",
          errorMessage: (e as Error).message,
          transaction: transactionId,
          network,
          payer: v.payer,
        };
      }
    } finally {
      client.close();
    }

    // Success reflects on-chain effects, not receipt status (spec phase 4.3–4.4).
    const records = await this.waitForRecords(transactionId);
    if (!records.length) {
      return { success: false, errorReason: "settlement_pending", transaction: transactionId, network, payer: v.payer };
    }
    const check = checkSettlementRecords(records, {
      asset: requirements.asset,
      amount: v.amount,
      payer: v.payer,
      payTo: requirements.payTo,
      feePayer: this.d.feePayerAccountId,
    });
    await this.audit(payload, requirements, v, check.ok, check.ok ? null : check.reason, transactionId);
    if (!check.ok) {
      return { success: false, errorReason: check.reason, errorMessage: check.message, transaction: transactionId, network, payer: v.payer };
    }
    return { success: true, transaction: transactionId, network, payer: v.payer, amount: v.amount.toString() };
  }

  // ------------------------------------------------------------------ phase 3: verification

  private async prepare(payload: PaymentPayload, req: PaymentRequirements): Promise<Check<Prepared>> {
    // 1. Shape.
    if (req.scheme !== X402_SCHEME || payload.accepted?.scheme !== X402_SCHEME) return fail("unsupported_scheme", "scheme must be exact");
    if (req.network !== X402_HEDERA_TESTNET) return fail("invalid_network", `unsupported network ${req.network}`);
    if (req.extra?.assetTransferMethod !== X402_TRANSFER_EXECUTOR) {
      return fail("invalid_exact_hedera_method", "assetTransferMethod must be transferExecutor");
    }
    const body = payload.payload as Record<string, unknown>;
    const payer = body.payer;
    const executor = body.executor;
    const authorization = body.authorization;
    if (typeof payer !== "string" || !isEntityId(payer)) return fail("invalid_payload", "payer must be a Hedera id 0.0.x");
    if (typeof executor !== "string" || !isEntityId(executor)) return fail("invalid_payload", "executor must be a Hedera id 0.0.x");
    if (typeof authorization !== "string" || !isHex(authorization)) return fail("invalid_payload", "authorization must be 0x hex");
    if (!isEntityId(req.payTo) || !(req.asset === X402_HBAR_ASSET || isEntityId(req.asset))) {
      return fail("invalid_requirements", "payTo and asset must be Hedera ids");
    }
    let amount: bigint;
    try {
      amount = BigInt(req.amount);
    } catch {
      return fail("invalid_requirements", "amount must be an integer string");
    }
    if (amount <= 0n) return fail("invalid_requirements", "amount must be positive");
    // A ConsumerAccount only executes transfers of its own funds.
    if (payer !== executor) return fail("invalid_exact_hedera_payer_mismatch", "payer must be the executor account");

    // 2–3. Method support and executor admission.
    if (!this.admitted.has(executor)) {
      return fail("invalid_exact_hedera_executor_not_admitted", `executor ${executor} is not admitted`);
    }

    // 4. Address resolution.
    const contract = await this.d.mirror.getContract(payer).catch(() => null);
    if (!contract?.evm_address) return fail("address_resolution_failed", `cannot resolve ${payer}`);
    const from = getAddress(contract.evm_address);
    const asset = x402AssetToAddress(req.asset);
    let to: Address;
    try {
      to = await resolveX402PayTo(this.d.mirror, req.payTo);
    } catch (e) {
      return fail("address_resolution_failed", (e as Error).message);
    }

    // 5. Construct the call only from requirements + payer (never client calldata).
    let decoded: ReturnType<typeof decodeTransferAuthorization>;
    try {
      decoded = decodeTransferAuthorization(authorization);
    } catch {
      return fail("invalid_payload", "authorization is not abi.encode(uint256,uint64,bytes)");
    }
    const data = encodeExecuteTransfer(from, asset, to, amount, authorization);
    const signer = await recoverTypedDataAddress({
      domain: consumerAccountDomain(this.d.chainId, from),
      types: TRANSFER_AUTHORIZATION_TYPES,
      primaryType: "TransferAuthorization",
      message: { from, asset, to, amount, nonce: decoded.nonce, validUntil: decoded.validUntil },
      signature: decoded.signature,
    }).catch(() => null);
    if (!signer) return fail("invalid_exact_hedera_signature", "authorization signature does not recover");
    const owner = await this.d.publicClient
      .readContract({ address: from, abi: consumerAccountAbi, functionName: "owner" })
      .catch(() => null);
    const actorType = owner && getAddress(owner) === signer ? "owner" : "session";

    // 6. Simulate from the submitting account; facilitator chooses the gas limit.
    let gas: bigint;
    try {
      await this.d.publicClient.call({ account: this.d.feePayerEvm, to: from, data });
      const est = await this.d.publicClient.estimateGas({ account: this.d.feePayerEvm, to: from, data });
      gas = (est * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
      if (gas < MIN_GAS) gas = MIN_GAS;
    } catch (e) {
      return fail("simulation_reverted", (e as { shortMessage?: string }).shortMessage ?? (e as Error).message);
    }
    if (gas > (this.d.maxGas ?? DEFAULT_MAX_GAS)) return fail("simulation_gas_exceeded", `gas ${gas} exceeds limit`);

    return { ok: true, value: { payer, executor, from, asset, to, amount, data, gas, signer, actorType } };
  }

  private async waitForRecords(transactionId: string): Promise<MirrorTransaction[]> {
    const mirrorId = toMirrorTransactionId(transactionId);
    const deadline = Date.now() + (this.d.recordTimeoutMs ?? 30_000);
    for (;;) {
      const records = await this.d.mirror.getTransactionRecords(mirrorId).catch(() => []);
      if (records.length) return records;
      if (Date.now() > deadline) return [];
      await new Promise(r => setTimeout(r, 2_000));
    }
  }

  private async audit(
    payload: PaymentPayload,
    req: PaymentRequirements,
    v: Prepared | null,
    allowed: boolean,
    reasonCode: string | null,
    transactionId: string | null,
  ): Promise<void> {
    if (!this.d.auditor) return;
    const authorization = (payload.payload as Record<string, unknown>)?.authorization;
    await this.d.auditor
      .submit({
        schemaVersion: 1,
        decisionId: keccak256(`0x${Buffer.from(`${String(authorization)}:${transactionId ?? "verify"}`).toString("hex")}`),
        account: v?.from ?? payerOf(payload) ?? "unknown",
        actor: v?.signer ?? "unknown",
        actorType: v?.actorType ?? "unknown",
        action: "x402-payment",
        target: req.payTo,
        asset: req.asset,
        amount: req.amount,
        allowed,
        reasonCode: allowed ? null : (reasonCode ?? "X402_DENIED"),
        decidedBy: transactionId ? "account-contract" : "sponsor-policy",
        intentHash: typeof authorization === "string" ? keccak256(authorization as Hex) : "0x",
        timestamp: new Date(this.d.now?.() ?? Date.now()).toISOString(),
        transactionId,
      })
      .catch(() => undefined);
  }
}

const payerOf = (payload: PaymentPayload): string | undefined => {
  const p = (payload.payload as Record<string, unknown> | undefined)?.payer;
  return typeof p === "string" ? p : undefined;
};

/** "0.0.123@1700000000.000000001" → "0.0.123-1700000000-000000001" (Mirror Node path form). */
export const toMirrorTransactionId = (id: string): string => {
  const [acct, ts] = id.split("@");
  if (!ts) return id;
  const [s, n] = ts.split(".");
  return `${acct}-${s}-${n}`;
};

/**
 * Settlement conformance over parent + child records (spec phase 4.3): payTo is credited exactly `amount` of
 * `asset`; only payer and fee payer are debited; no other token moves; every record succeeded.
 */
export function checkSettlementRecords(
  records: MirrorTransaction[],
  x: { asset: string; amount: bigint; payer: string; payTo: string; feePayer: string },
): { ok: true } | { ok: false; reason: string; message: string } {
  const bad = (message: string) => ({ ok: false as const, reason: "settlement_nonconforming", message });
  if (records.some(r => r.result !== "SUCCESS")) return bad("a settlement record did not succeed");

  const hbar = new Map<string, bigint>();
  const tokens = new Map<string, Map<string, bigint>>();
  for (const r of records) {
    for (const t of r.transfers ?? []) hbar.set(t.account, (hbar.get(t.account) ?? 0n) + BigInt(t.amount));
    for (const t of r.token_transfers ?? []) {
      const m = tokens.get(t.token_id) ?? new Map<string, bigint>();
      m.set(t.account, (m.get(t.account) ?? 0n) + BigInt(t.amount));
      tokens.set(t.token_id, m);
    }
  }
  const fees = records.reduce((s, r) => s + BigInt(r.charged_tx_fee ?? 0), 0n);

  if (x.asset === X402_HBAR_ASSET) {
    if ((hbar.get(x.payTo) ?? 0n) !== x.amount) return bad(`payTo credited ${hbar.get(x.payTo) ?? 0n}, expected ${x.amount}`);
    if ((hbar.get(x.payer) ?? 0n) !== -x.amount) return bad(`payer debited ${hbar.get(x.payer) ?? 0n}, expected -${x.amount}`);
    for (const [, m] of tokens) for (const [, v] of m) if (v !== 0n) return bad("unexpected token movement");
  } else {
    const m = tokens.get(x.asset) ?? new Map<string, bigint>();
    if ((m.get(x.payTo) ?? 0n) !== x.amount) return bad(`payTo credited ${m.get(x.payTo) ?? 0n} of ${x.asset}`);
    if ((m.get(x.payer) ?? 0n) !== -x.amount) return bad(`payer debited ${m.get(x.payer) ?? 0n} of ${x.asset}`);
    for (const [acct, v] of m) if (acct !== x.payTo && acct !== x.payer && v !== 0n) return bad(`third party ${acct} moved ${x.asset}`);
    for (const [tok, mm] of tokens) if (tok !== x.asset) for (const [, v] of mm) if (v !== 0n) return bad(`unexpected token ${tok}`);
    if ((hbar.get(x.payer) ?? 0n) < 0n) return bad("payer was debited HBAR");
  }
  for (const [acct, v] of hbar) {
    if (v < 0n && acct !== x.payer && acct !== x.feePayer) return bad(`third party ${acct} was debited HBAR`);
  }
  if (-(hbar.get(x.feePayer) ?? 0n) > fees) return bad("fee payer debited beyond the network fee");
  return { ok: true };
}
