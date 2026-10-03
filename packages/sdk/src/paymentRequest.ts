import { type Address, type Hex, type PublicClient, getAddress, recoverTypedDataAddress } from "viem";
import { z } from "zod";
import { consumerAccountAbi } from "./abi";
import type { TypedDataSigner } from "./intent";

/**
 * Canonical payment request. QR codes and share links carry the same signed payload, so the amount, asset and
 * recipient cannot be edited without invalidating the requester's signature.
 */
export type PaymentRequest = {
  chainId: number;
  recipient: Address;
  /** address(0) = HBAR (tinybars), otherwise an HTS token EVM address. */
  asset: Address;
  /** Smallest unit of the asset. */
  amount: bigint;
  memo: string;
  /** Unix seconds. */
  expiresAt: bigint;
  referenceId: string;
};

export const PAYMENT_REQUEST_TYPES = {
  PaymentRequest: [
    { name: "recipient", type: "address" },
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "memo", type: "string" },
    { name: "expiresAt", type: "uint64" },
    { name: "referenceId", type: "string" },
  ],
} as const;

const domain = (chainId: number) => ({ name: "ConsumerPaymentRequest", version: "1", chainId }) as const;

const wireSchema = z.object({
  v: z.literal(1),
  c: z.number().int(),
  r: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  a: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  n: z.string().regex(/^\d+$/),
  m: z.string().max(100),
  e: z.string().regex(/^\d+$/),
  i: z.string().max(64),
  s: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});

export type SignedPaymentRequest = { request: PaymentRequest; signature: Hex };

export async function signPaymentRequest(signer: TypedDataSigner, request: PaymentRequest): Promise<SignedPaymentRequest> {
  if (request.memo.length > 100) throw new Error("memo longer than 100 characters");
  if (request.referenceId.length > 64) throw new Error("referenceId longer than 64 characters");
  if (request.amount <= 0n) throw new Error("amount must be positive");
  const signature = await signer.signTypedData({
    domain: domain(request.chainId),
    types: PAYMENT_REQUEST_TYPES,
    primaryType: "PaymentRequest",
    message: request,
  });
  return { request, signature };
}

const b64url = {
  encode: (s: string) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  decode: (s: string) => decodeURIComponent(escape(atob(s.replace(/-/g, "+").replace(/_/g, "/")))),
};

/** Compact URL-safe encoding used by both QR codes and links. */
export function encodePaymentRequest({ request: q, signature }: SignedPaymentRequest): string {
  return b64url.encode(
    JSON.stringify({
      v: 1,
      c: q.chainId,
      r: q.recipient,
      a: q.asset,
      n: q.amount.toString(),
      m: q.memo,
      e: q.expiresAt.toString(),
      i: q.referenceId,
      s: signature,
    }),
  );
}

export function decodePaymentRequest(encoded: string): SignedPaymentRequest {
  const raw = (() => {
    try {
      return JSON.parse(b64url.decode(encoded.trim()));
    } catch {
      throw new Error("not a payment request");
    }
  })();
  const w = wireSchema.parse(raw);
  return {
    request: {
      chainId: w.c,
      recipient: getAddress(w.r),
      asset: getAddress(w.a),
      amount: BigInt(w.n),
      memo: w.m,
      expiresAt: BigInt(w.e),
      referenceId: w.i,
    },
    signature: w.s as Hex,
  };
}

export type PaymentRequestCheck =
  | { valid: true; signer: Address; signerRole: "recipient" | "recipient-account-owner" }
  | { valid: false; reason: "EXPIRED" | "WRONG_NETWORK" | "SIGNER_NOT_RECIPIENT" };

/**
 * A request is valid when it is unexpired, on the expected chain, and signed by the recipient itself or by the
 * owner of the recipient ConsumerAccount (checked on-chain when a client is given).
 */
export async function verifyPaymentRequest(
  signed: SignedPaymentRequest,
  opts: { chainId: number; nowSeconds?: number; client?: PublicClient },
): Promise<PaymentRequestCheck> {
  const { request, signature } = signed;
  if (request.chainId !== opts.chainId) return { valid: false, reason: "WRONG_NETWORK" };
  const now = BigInt(opts.nowSeconds ?? Math.floor(Date.now() / 1000));
  if (request.expiresAt <= now) return { valid: false, reason: "EXPIRED" };
  const signer = await recoverTypedDataAddress({
    domain: domain(request.chainId),
    types: PAYMENT_REQUEST_TYPES,
    primaryType: "PaymentRequest",
    message: request,
    signature,
  });
  if (signer === request.recipient) return { valid: true, signer, signerRole: "recipient" };
  if (opts.client) {
    const owner = await opts.client
      .readContract({ address: request.recipient, abi: consumerAccountAbi, functionName: "owner" })
      .catch(() => null);
    if (owner && getAddress(owner) === signer) return { valid: true, signer, signerRole: "recipient-account-owner" };
  }
  return { valid: false, reason: "SIGNER_NOT_RECIPIENT" };
}
