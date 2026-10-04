import {
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Account,
  type Transport,
  getAddress,
  hashTypedData,
  recoverTypedDataAddress,
  keccak256,
  toHex,
} from "viem";
import {
  type ActionName,
  type DecodedRevert,
  type MirrorClient,
  type MirrorVerification,
  OWNER_INTENT_TYPES,
  type Receipt,
  SESSION_ACTION_TYPES,
  type SponsorDenialCode,
  type SponsorRequest,
  actionNameOf,
  consumerAccountAbi,
  consumerAccountDomain,
  consumerAccountFactoryAbi,
  decodeRevertData,
  decodeSwapToPay,
  decodeVaultDeposit,
  decodeTransferAction,
  encodeCreateAccount,
  encodeExecuteOwnerIntent,
  encodeExecuteSessionAction,
  sponsorRequestSchema,
  weibarsToTinybars,
} from "@sh/sdk";
import type { AuditRecord, Auditor } from "./audit";
import { type SponsorLimits, checkSponsorPolicy, recordRequest, recordSpend, rollDay } from "./policy";
import type { RelayerStore } from "./store";

export type SponsorDeps = {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  chainId: number;
  factory: Address;
  sponsorAccountId: string | null;
  limits: SponsorLimits;
  store: RelayerStore;
  /** null on local chains without a Mirror Node; receipts then say mirror verification is pending. */
  mirror: MirrorClient | null;
  /** null disables HCS auditing; receipts then carry hcsAudit = null and auditError explains why. */
  auditor: Auditor | null;
  now?: () => number;
};

/** Minimum time an intent must remain valid when it reaches the sponsor (covers submission latency). */
const MIN_VALIDITY_SECONDS = 10n;
/** Extra headroom over eth_estimateGas; HTS system-contract calls are under-estimated by some relays. */
const GAS_HEADROOM_NUM = 13n;
const GAS_HEADROOM_DEN = 10n;
const MIN_GAS = 150_000n;
// eth_estimateGas does not model HIP-904: the HTS system call converts the airdrop fee (incl. the pending-airdrop
// charge for unassociated receivers) into gas at execution time. Observed: 150k and later 1.5M (through an account
// clone) → INSUFFICIENT_GAS from 0x167; 2.5M leaves headroom.
const AIRDROP_MIN_GAS = 2_500_000n;
// SaucerSwap pool creation from a contract (launchpad graduation) measured ~8.3M gas on testnet.
const MAX_GAS = 12_000_000n;

type Prepared = {
  user: string;
  account: Address;
  actor: Address;
  actorType: "owner" | "session" | "sponsor";
  action: ActionName | "owner-intent" | "account-create";
  to: Address;
  data: Hex;
  dedupeKey: string;
  intentHash: Hex;
  summary: { asset: Address | null; amount: bigint | null; recipient: Address | null; target: Address | null };
  /** Client-requested gas floor (owner intents doing HTS work); capped at MAX_GAS. */
  minGas?: bigint;
};

export type SponsorResult = { receipt: Receipt; auditError: string | null };

export class Sponsor {
  constructor(private readonly d: SponsorDeps) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  /** Full pipeline: validate → network → expiry → dedupe → policy → simulate → submit → verify → receipt → audit. */
  async handle(raw: unknown): Promise<SponsorResult> {
    const parsed = sponsorRequestSchema.safeParse(raw);
    if (!parsed.success) return this.deny(null, "SPONSOR_REQUEST_INVALID", parsed.error.issues[0]?.message ?? "invalid");
    const req = parsed.data;
    if (req.chainId !== this.d.chainId) {
      return this.deny(null, "SPONSOR_WRONG_NETWORK", `expected chain ${this.d.chainId}, got ${req.chainId}`);
    }

    let p: Prepared;
    try {
      p = await this.prepare(req);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "SPONSOR_REQUEST_EXPIRED") return this.deny(null, "SPONSOR_REQUEST_EXPIRED", "intent expires too soon");
      return this.deny(null, "SPONSOR_REQUEST_INVALID", msg);
    }

    const nowMs = this.now();
    this.d.store.spend = rollDay(this.d.store.spend, nowMs);
    if (!this.d.store.claim(p.dedupeKey)) return this.deny(p, "SPONSOR_DUPLICATE_REQUEST", "request already processed");

    try {
      // Simulation: the account contract is the authority; a revert here is an on-chain policy decision.
      try {
        await this.d.publicClient.call({ account: this.d.walletClient.account, to: p.to, data: p.data });
      } catch (e) {
        this.d.store.release(p.dedupeKey);
        return this.denyByContract(p, extractRevert(e));
      }

      const gas = await this.estimateGas(p);
      const gasPrice = await this.d.publicClient.getGasPrice();
      const estimatedFee = weibarsToTinybars(gas * gasPrice);
      const decision = checkSponsorPolicy(this.d.store.spend, this.d.limits, p.user, estimatedFee, nowMs);
      recordRequest(this.d.store.spend, p.user, nowMs);
      if (!decision.ok) {
        this.d.store.release(p.dedupeKey);
        return this.deny(p, decision.code, decision.detail);
      }

      const hash = await this.d.walletClient.sendTransaction({ to: p.to, data: p.data, gas });
      const evmReceipt = await this.d.publicClient.waitForTransactionReceipt({ hash });
      if (evmReceipt.status !== "success") {
        // Receipts carry no revert data; Mirror Node records it, so decode the real reason when available
        // (e.g. a cap exceeded only once network fees were known on chain).
        let decoded: DecodedRevert = { reason: "UNKNOWN_REVERT", errorName: null, args: [] };
        if (this.d.mirror) {
          const result = await this.d.mirror.waitForContractResult(hash, 20_000).catch(() => null);
          const data = result?.error_message;
          if (data && data.startsWith("0x") && data.length > 2) decoded = decodeRevertData(data as Hex);
        }
        return this.denyByContract(p, decoded, hash);
      }

      const verification = await this.verify(hash);
      const feeTinybars = verification.feeTinybars ?? weibarsToTinybars(evmReceipt.gasUsed * evmReceipt.effectiveGasPrice);
      recordSpend(this.d.store.spend, p.user, feeTinybars);

      const receipt: Receipt = {
        status: "success",
        id: hash,
        account: p.account,
        actor: p.actor,
        actorType: p.actorType,
        sponsor: this.d.sponsorAccountId,
        createdAt: new Date(nowMs).toISOString(),
        hcsAudit: null,
        action: p.action,
        assetIn: p.action === "swapToPay" ? p.summary.asset : null,
        amountIn: null,
        assetOut: p.action === "swapToPay" ? null : p.summary.asset,
        amountOut: p.summary.amount,
        recipient: p.summary.recipient,
        transactionHash: hash,
        transactionId: verification.transactionId,
        consensusTimestamp: verification.mirror.status === "verified" ? verification.mirror.consensusTimestamp : "",
        networkFeeTinybars: feeTinybars,
        mirror: verification.mirror,
        protocolMetadata: { gasUsed: evmReceipt.gasUsed.toString(), blockNumber: evmReceipt.blockNumber.toString() },
      };
      return this.finish(p, receipt, { allowed: true, reasonCode: null, decidedBy: "account-contract" });
    } finally {
      this.d.store.save();
    }
  }

  private async prepare(req: SponsorRequest): Promise<Prepared> {
    if (req.kind === "create-account") {
      const owner = getAddress(req.owner);
      const salt = req.salt as Hex;
      const account = await this.d.publicClient.readContract({
        address: this.d.factory,
        abi: consumerAccountFactoryAbi,
        functionName: "getAddress",
        args: [owner, salt],
      });
      const data = encodeCreateAccount(owner, salt);
      return {
        user: owner.toLowerCase(),
        account,
        actor: owner,
        actorType: "owner",
        action: "account-create",
        to: this.d.factory,
        data,
        dedupeKey: `create:${account.toLowerCase()}`,
        intentHash: keccak256(data),
        summary: { asset: null, amount: null, recipient: null, target: this.d.factory },
      };
    }

    const account = getAddress(req.account);
    await this.requireFactoryAccount(account);
    const nowS = BigInt(Math.floor(this.now() / 1000));

    if (req.kind === "owner-intent") {
      const intent = {
        calls: req.intent.calls.map(c => ({ target: getAddress(c.target), value: BigInt(c.value), data: c.data as Hex })),
        nonce: BigInt(req.intent.nonce),
        validUntil: BigInt(req.intent.validUntil),
      };
      if (intent.validUntil < nowS + MIN_VALIDITY_SECONDS) throw new Error("SPONSOR_REQUEST_EXPIRED");
      const intentHash = hashTypedData({
        domain: consumerAccountDomain(this.d.chainId, account),
        types: OWNER_INTENT_TYPES,
        primaryType: "OwnerIntent",
        message: intent,
      });
      const first = intent.calls[0]!;
      const owner = await this.readOwner(account);
      const signer = await recoverTypedDataAddress({
        domain: consumerAccountDomain(this.d.chainId, account),
        types: OWNER_INTENT_TYPES,
        primaryType: "OwnerIntent",
        message: intent,
        signature: req.signature as Hex,
      }).catch(() => null);
      return {
        user: account.toLowerCase(),
        account,
        actor: signer ?? owner,
        actorType: signer && signer === owner ? "owner" : "session",
        action: "owner-intent",
        to: account,
        data: encodeExecuteOwnerIntent(intent, req.signature as Hex),
        dedupeKey: `sig:${keccak256(req.signature as Hex)}`,
        intentHash,
        summary: { asset: null, amount: first.value, recipient: null, target: first.target },
        ...(req.minGas ? { minGas: BigInt(req.minGas) } : {}),
      };
    }

    const action = {
      actionId: req.action.actionId as Hex,
      actionData: req.action.actionData as Hex,
      nonce: BigInt(req.action.nonce),
      validUntil: BigInt(req.action.validUntil),
    };
    if (action.validUntil < nowS + MIN_VALIDITY_SECONDS) throw new Error("SPONSOR_REQUEST_EXPIRED");
    const name = actionNameOf(action.actionId);
    let summary: Prepared["summary"] = { asset: null, amount: null, recipient: null, target: null };
    if (name === "payment" || name === "airdrop") {
      const t = decodeTransferAction(action.actionData);
      summary = { asset: t.asset, amount: t.amount, recipient: t.to, target: null };
    } else if (name === "swapToPay") {
      const s = decodeSwapToPay(action.actionData);
      summary = { asset: s.tokenIn, amount: s.amountOut, recipient: s.to, target: s.router };
    } else if (name === "vaultDeposit") {
      const v = decodeVaultDeposit(action.actionData);
      summary = { asset: null, amount: v.assets, recipient: v.vault, target: v.vault };
    }
    const intentHash = hashTypedData({
      domain: consumerAccountDomain(this.d.chainId, account),
      types: SESSION_ACTION_TYPES,
      primaryType: "SessionAction",
      message: action,
    });
    const owner = await this.readOwner(account);
    const signer = await recoverTypedDataAddress({
      domain: consumerAccountDomain(this.d.chainId, account),
      types: SESSION_ACTION_TYPES,
      primaryType: "SessionAction",
      message: action,
      signature: req.signature as Hex,
    }).catch(() => null);
    return {
      user: account.toLowerCase(),
      account,
      actor: signer ?? owner,
      actorType: signer && signer === owner ? "owner" : "session",
      action: name ?? "payment",
      to: account,
      data: encodeExecuteSessionAction(action, req.signature as Hex),
      dedupeKey: `sig:${keccak256(req.signature as Hex)}`,
      intentHash,
      summary,
    };
  }

  /** Sponsorship is only offered to accounts deployed by this relayer's factory (default salt 0). */
  private async requireFactoryAccount(account: Address): Promise<void> {
    await this.readOwner(account);
    // The factory records every account it deployed; this survives guardian recovery changing the owner.
    const known = await this.d.publicClient.readContract({
      address: this.d.factory,
      abi: consumerAccountFactoryAbi,
      functionName: "isAccount",
      args: [account],
    });
    if (!known) throw new Error("account was not deployed by this sponsor's factory");
  }

  private async readOwner(account: Address): Promise<Address> {
    try {
      return await this.d.publicClient.readContract({ address: account, abi: consumerAccountAbi, functionName: "owner" });
    } catch {
      throw new Error("address is not a ConsumerAccount");
    }
  }

  private async estimateGas(p: Prepared): Promise<bigint> {
    const est = await this.d.publicClient.estimateGas({ account: this.d.walletClient.account, to: p.to, data: p.data });
    const padded = (est * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN;
    let floor = p.action === "airdrop" ? AIRDROP_MIN_GAS : MIN_GAS;
    if (p.minGas && p.minGas > floor) floor = p.minGas > MAX_GAS ? MAX_GAS : p.minGas;
    return padded < floor ? floor : padded > MAX_GAS ? MAX_GAS : padded;
  }

  private async verify(
    hash: Hex,
  ): Promise<{ mirror: MirrorVerification; transactionId: string | null; feeTinybars: bigint | null }> {
    const checkedAt = new Date(this.now()).toISOString();
    if (!this.d.mirror) {
      return { mirror: { status: "pending", detail: "no Mirror Node on this network", checkedAt }, transactionId: null, feeTinybars: null };
    }
    try {
      const r = await this.d.mirror.waitForContractResult(hash);
      const tx = await this.d.mirror.getTransactionAt(r.timestamp);
      const mirror: MirrorVerification =
        r.result === "SUCCESS"
          ? { status: "verified", result: r.result, consensusTimestamp: r.timestamp, checkedAt }
          : { status: "mismatch", result: r.result, detail: r.error_message ?? "non-success result", checkedAt };
      return {
        mirror,
        transactionId: tx?.transaction_id ?? null,
        feeTinybars: tx ? BigInt(tx.charged_tx_fee) : null,
      };
    } catch (e) {
      return { mirror: { status: "pending", detail: (e as Error).message, checkedAt }, transactionId: null, feeTinybars: null };
    }
  }

  private async denyByContract(p: Prepared, revert: DecodedRevert, hash: Hex | null = null): Promise<SponsorResult> {
    const receipt: Receipt = {
      status: "denied",
      id: hash ?? p.intentHash,
      account: p.account,
      actor: p.actor,
      actorType: p.actorType,
      sponsor: this.d.sponsorAccountId,
      createdAt: new Date(this.now()).toISOString(),
      hcsAudit: null,
      action: p.action,
      reasonCode: revert.reason,
      deniedBy: "account-contract",
      transactionHash: hash,
      detail: revert.errorName ?? "reverted",
    };
    return this.finish(p, receipt, { allowed: false, reasonCode: revert.reason, decidedBy: "account-contract" });
  }

  private async deny(p: Prepared | null, code: SponsorDenialCode, detail: string): Promise<SponsorResult> {
    const zero = "0x0000000000000000000000000000000000000000" as Address;
    const receipt: Receipt = {
      status: "denied",
      id: p?.intentHash ?? keccak256(toHex(`${code}:${detail}:${this.now()}`)),
      account: p?.account ?? zero,
      actor: p?.actor ?? zero,
      actorType: p?.actorType ?? "sponsor",
      sponsor: this.d.sponsorAccountId,
      createdAt: new Date(this.now()).toISOString(),
      hcsAudit: null,
      action: p?.action ?? "owner-intent",
      reasonCode: code,
      deniedBy: "sponsor-policy",
      transactionHash: null,
      detail,
    };
    // Malformed requests are not audited publicly (nothing meaningful to attribute).
    if (!p) {
      this.d.store.addReceipt(receipt);
      return { receipt, auditError: null };
    }
    return this.finish(p, receipt, { allowed: false, reasonCode: code, decidedBy: "sponsor-policy" });
  }

  private async finish(
    p: Prepared,
    receipt: Receipt,
    decision: { allowed: boolean; reasonCode: string | null; decidedBy: AuditRecord["decidedBy"] },
  ): Promise<SponsorResult> {
    let auditError: string | null = null;
    if (this.d.auditor) {
      try {
        receipt.hcsAudit = await this.d.auditor.submit({
          schemaVersion: 1,
          decisionId: receipt.id,
          account: p.account,
          actor: p.actor,
          actorType: p.actorType,
          action: p.action,
          target: p.summary.target,
          asset: p.summary.asset,
          amount: p.summary.amount?.toString() ?? null,
          allowed: decision.allowed,
          reasonCode: decision.reasonCode,
          decidedBy: decision.decidedBy,
          intentHash: p.intentHash,
          timestamp: receipt.createdAt,
          transactionId: receipt.status === "success" ? receipt.transactionId : null,
        });
      } catch (e) {
        auditError = `HCS_AUDIT_FAILED: ${(e as Error).message}`;
      }
    } else {
      auditError = "HCS_AUDIT_FAILED: no audit topic configured";
    }
    this.d.store.addReceipt(receipt);
    return { receipt, auditError };
  }
}

function extractRevert(e: unknown): DecodedRevert {
  let cur: unknown = e;
  for (let i = 0; i < 8 && cur; i++) {
    const data = (cur as { data?: unknown }).data;
    if (typeof data === "string" && data.startsWith("0x")) return decodeRevertData(data as Hex);
    if (data && typeof (data as { data?: unknown }).data === "string") return decodeRevertData((data as { data: Hex }).data);
    cur = (cur as { cause?: unknown }).cause;
  }
  return { reason: "UNKNOWN_REVERT", errorName: null, args: [] };
}

