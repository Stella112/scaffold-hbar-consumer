import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, getAddress } from "viem";
import { consumerAccountAbi } from "./abi";
import { HBAR } from "./actions";
import { entityIdToLongZero, isEntityId } from "./hedera";
import { type TypedDataSigner, signTransferAuthorization } from "./intent";
import type { MirrorClient } from "./mirror";

/**
 * x402 `exact` scheme on Hedera, `transferExecutor` asset-transfer method
 * (x402-foundation/x402 specs/schemes/exact/scheme_exact_hedera.md).
 *
 * A ConsumerAccount is its own executor: it implements `ITransferExecutor.executeTransfer(from, asset, to, amount,
 * authorization)` and only moves its own funds (`from == address(this)`). `authorization` is
 * `abi.encode(uint256 nonce, uint64 validUntil, bytes signature)` over the account's EIP-712 TransferAuthorization.
 */
export const X402_VERSION = 2;
export const X402_SCHEME = "exact";
export const X402_HEDERA_TESTNET = "hedera:testnet";
export const X402_TRANSFER_EXECUTOR = "transferExecutor";
/** x402 Hedera asset id for native HBAR. */
export const X402_HBAR_ASSET = "0.0.0";

/** Wire shapes, structurally identical to @x402/core types (kept local so the SDK stays framework-independent). */
export type X402PaymentRequirements = {
  scheme: string;
  network: `${string}:${string}`;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
};

export type TransferExecutorPayload = {
  /** Hedera ID (0.0.x) of the account debited: the ConsumerAccount contract. */
  payer: string;
  /** Hedera contract ID (0.0.x) implementing ITransferExecutor; the same ConsumerAccount. */
  executor: string;
  authorization: Hex;
};

/** `asset` to the EVM address the executor expects: address(0) for HBAR, otherwise the token's long-zero address. */
export function x402AssetToAddress(asset: string): Address {
  if (asset === X402_HBAR_ASSET) return HBAR;
  if (!isEntityId(asset)) throw new Error(`x402 asset must be a Hedera entity id, got ${asset}`);
  return entityIdToLongZero(asset);
}

/** The part of MirrorClient needed to resolve accounts (lets tests pass a stub). */
export type AccountResolver = Pick<MirrorClient, "getAccount">;

/**
 * `payTo` to the EVM address a contract must send to. Rule shared by client and facilitator: the account's EVM
 * alias when it has one, otherwise its long-zero address. Hedera rejects native HBAR sent from a contract to the
 * long-zero address of an aliased account (NativeTransferFailed, observed on testnet), so the alias is required.
 * Session recipient allowlists must use this same address.
 */
export async function resolveX402PayTo(mirror: AccountResolver, payTo: string): Promise<Address> {
  if (!isEntityId(payTo)) throw new Error(`x402 payTo must be a Hedera account id, got ${payTo}`);
  const acct = await mirror.getAccount(payTo);
  if (!acct) throw new Error(`x402 payTo ${payTo} not found on Mirror Node`);
  return acct.evm_address && !/^0x0{24}/i.test(acct.evm_address) ? getAddress(acct.evm_address) : entityIdToLongZero(payTo);
}

export const encodeTransferAuthorization = (nonce: bigint, validUntil: bigint, signature: Hex): Hex =>
  encodeAbiParameters([{ type: "uint256" }, { type: "uint64" }, { type: "bytes" }], [nonce, validUntil, signature]);

export function decodeTransferAuthorization(authorization: Hex): { nonce: bigint; validUntil: bigint; signature: Hex } {
  const [nonce, validUntil, signature] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint64" }, { type: "bytes" }],
    authorization,
  );
  return { nonce, validUntil, signature };
}

export const encodeExecuteTransfer = (from: Address, asset: Address, to: Address, amount: bigint, authorization: Hex): Hex =>
  encodeFunctionData({
    abi: consumerAccountAbi,
    functionName: "executeTransfer",
    args: [from, asset, to, amount, authorization],
  });

export type CreateTransferExecutorPayloadArgs = {
  /** Owner or a session key holding the x402-payment action. */
  signer: TypedDataSigner;
  chainId: number;
  /** ConsumerAccount EVM address (`address(this)` inside the contract). */
  account: Address;
  /** ConsumerAccount Hedera contract id (0.0.x). */
  accountId: string;
  requirements: X402PaymentRequirements;
  /** Resolves payTo exactly as the facilitator does (Mirror Node). */
  mirror: AccountResolver;
  nonce?: bigint;
  now?: () => number;
};

/** Client side of the method: binds exactly (from, asset, payTo, amount) from the requirements and signs it. */
export async function createTransferExecutorPayload(a: CreateTransferExecutorPayloadArgs): Promise<TransferExecutorPayload> {
  const r = a.requirements;
  if (r.scheme !== X402_SCHEME) throw new Error(`unsupported scheme ${r.scheme}`);
  if (r.extra?.assetTransferMethod !== X402_TRANSFER_EXECUTOR) throw new Error("requirements do not offer transferExecutor");
  const executors = Array.isArray(r.extra.executors) ? (r.extra.executors as string[]) : [];
  if (!executors.includes(a.accountId)) throw new Error(`executor ${a.accountId} is not admitted by this resource`);
  const amount = BigInt(r.amount);
  if (amount <= 0n) throw new Error("amount must be positive");
  const nowS = Math.floor((a.now?.() ?? Date.now()) / 1000);
  const nonce = a.nonce ?? BigInt(`0x${Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("")}`);
  const validUntil = BigInt(nowS + r.maxTimeoutSeconds);
  const from = getAddress(a.account);
  const signature = await signTransferAuthorization(a.signer, a.chainId, {
    from,
    asset: x402AssetToAddress(r.asset),
    to: await resolveX402PayTo(a.mirror, r.payTo),
    amount,
    nonce,
    validUntil,
  });
  return { payer: a.accountId, executor: a.accountId, authorization: encodeTransferAuthorization(nonce, validUntil, signature) };
}

/**
 * `SchemeNetworkClient` for @x402/core's `x402Client` (structurally typed, no framework dependency):
 * `new x402Client().register("hedera:testnet", new TransferExecutorClient({ signer, chainId, account, accountId }))`.
 */
export class TransferExecutorClient {
  readonly scheme = X402_SCHEME;

  constructor(private readonly cfg: Omit<CreateTransferExecutorPayloadArgs, "requirements">) {}

  async createPaymentPayload(x402Version: number, requirements: X402PaymentRequirements) {
    const payload = await createTransferExecutorPayload({ ...this.cfg, requirements });
    return { x402Version, payload: payload as unknown as Record<string, unknown> };
  }
}

/**
 * @x402/core client spend controls admitting HBAR on Hedera testnet with an atomic per-payment cap.
 * Defence in depth: the ConsumerAccount still enforces the session's USD caps on chain.
 */
export const x402HbarSpendControls = (maxTinybarsPerPayment: bigint) => ({
  allowedAssets: [
    { network: X402_HEDERA_TESTNET as `${string}:${string}`, asset: X402_HBAR_ASSET, maxAmountPerPayment: maxTinybarsPerPayment.toString() },
  ],
});
