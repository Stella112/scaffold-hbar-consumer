import { type Address, type Hex, bytesToBigInt } from "viem";

/** EIP-712 domain/types. Must match ConsumerAccount (name "ConsumerAccount", version "1"). */
export const EIP712_NAME = "ConsumerAccount";
export const EIP712_VERSION = "1";

export const consumerAccountDomain = (chainId: number, account: Address) =>
  ({ name: EIP712_NAME, version: EIP712_VERSION, chainId, verifyingContract: account }) as const;

export const OWNER_INTENT_TYPES = {
  Call: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
  OwnerIntent: [
    { name: "calls", type: "Call[]" },
    { name: "nonce", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export const SESSION_ACTION_TYPES = {
  SessionAction: [
    { name: "actionId", type: "bytes32" },
    { name: "actionData", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export const TRANSFER_AUTHORIZATION_TYPES = {
  TransferAuthorization: [
    { name: "from", type: "address" },
    { name: "asset", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

export type Call = { target: Address; value: bigint; data: Hex };
export type OwnerIntent = { calls: Call[]; nonce: bigint; validUntil: bigint };
export type SessionAction = { actionId: Hex; actionData: Hex; nonce: bigint; validUntil: bigint };
export type TransferAuthorization = {
  from: Address;
  asset: Address;
  to: Address;
  amount: bigint;
  nonce: bigint;
  validUntil: bigint;
};

/** Anything that can sign EIP-712 typed data (viem LocalAccount, WalletClient account, ...). */
export type TypedDataSigner = {
  address: Address;
  signTypedData: (args: any) => Promise<Hex>;
};

/** Nonces are unordered and single-use; 256 random bits make collisions negligible. */
export function randomNonce(): bigint {
  return bytesToBigInt(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export const expiryIn = (seconds: number, now = Date.now()): bigint => BigInt(Math.floor(now / 1000) + seconds);

export function buildOwnerIntent(calls: Call[], ttlSeconds = 300): OwnerIntent {
  if (calls.length === 0) throw new Error("owner intent needs at least one call");
  return { calls, nonce: randomNonce(), validUntil: expiryIn(ttlSeconds) };
}

export function buildSessionAction(actionId: Hex, actionData: Hex, ttlSeconds = 300): SessionAction {
  return { actionId, actionData, nonce: randomNonce(), validUntil: expiryIn(ttlSeconds) };
}

export const signOwnerIntent = (signer: TypedDataSigner, chainId: number, account: Address, intent: OwnerIntent) =>
  signer.signTypedData({
    domain: consumerAccountDomain(chainId, account),
    types: OWNER_INTENT_TYPES,
    primaryType: "OwnerIntent",
    message: intent,
  });

export const signSessionAction = (
  signer: TypedDataSigner,
  chainId: number,
  account: Address,
  action: SessionAction,
) =>
  signer.signTypedData({
    domain: consumerAccountDomain(chainId, account),
    types: SESSION_ACTION_TYPES,
    primaryType: "SessionAction",
    message: action,
  });

export const signTransferAuthorization = (signer: TypedDataSigner, chainId: number, auth: TransferAuthorization) =>
  signer.signTypedData({
    domain: consumerAccountDomain(chainId, auth.from),
    types: TRANSFER_AUTHORIZATION_TYPES,
    primaryType: "TransferAuthorization",
    message: auth,
  });
