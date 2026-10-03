import { type Address, type Hex, decodeAbiParameters, encodeAbiParameters, keccak256, toBytes } from "viem";

const id = (name: string): Hex => keccak256(toBytes(name));

/** Typed action IDs. Mirrors packages/foundry/contracts/Actions.sol; changing one is breaking. */
export const ACTION_IDS = {
  payment: id("consumer.action.payment.v1"),
  airdrop: id("consumer.action.airdrop.v1"),
  x402Payment: id("consumer.action.x402-payment.v1"),
  swapToPay: id("consumer.action.swap-to-pay.v1"),
  vaultDeposit: id("consumer.action.vault-deposit.v1"),
} as const;

/** Reserved IDs a session can never use (the contract answers PRIVILEGE_ESCALATION / WITHDRAW_FORBIDDEN). */
export const RESERVED_ACTION_IDS = {
  adminSetOwner: id("consumer.admin.set-owner.v1"),
  adminGrantSession: id("consumer.admin.grant-session.v1"),
  adminRevokeSession: id("consumer.admin.revoke-session.v1"),
  adminSetGuardians: id("consumer.admin.set-guardians.v1"),
  adminRecovery: id("consumer.admin.recovery.v1"),
  adminSetOracle: id("consumer.admin.set-oracle.v1"),
  vaultWithdraw: id("consumer.action.vault-withdraw.v1"),
  vaultRedeem: id("consumer.action.vault-redeem.v1"),
} as const;

export type ActionName = keyof typeof ACTION_IDS;

/** address(0) denotes HBAR (amount in tinybars). */
export const HBAR: Address = "0x0000000000000000000000000000000000000000";

export type TransferActionInput = { asset: Address; to: Address; amount: bigint };

export type SwapToPayInput = {
  router: Address;
  tokenIn: Address;
  amountInMaximum: bigint;
  tokenOut: Address;
  amountOut: bigint;
  to: Address;
  deadline: bigint;
  path: Hex;
};

const transferParams = [
  { type: "address", name: "asset" },
  { type: "address", name: "to" },
  { type: "uint256", name: "amount" },
] as const;

const swapToPayParams = [
  {
    type: "tuple",
    components: [
      { type: "address", name: "router" },
      { type: "address", name: "tokenIn" },
      { type: "uint256", name: "amountInMaximum" },
      { type: "address", name: "tokenOut" },
      { type: "uint256", name: "amountOut" },
      { type: "address", name: "to" },
      { type: "uint256", name: "deadline" },
      { type: "bytes", name: "path" },
    ],
  },
] as const;

export const encodePayment = (i: TransferActionInput): Hex =>
  encodeAbiParameters(transferParams, [i.asset, i.to, i.amount]);

export const encodeAirdrop = encodePayment;

export const decodeTransferAction = (data: Hex): TransferActionInput => {
  const [asset, to, amount] = decodeAbiParameters(transferParams, data);
  return { asset, to, amount };
};

export const encodeSwapToPay = (i: SwapToPayInput): Hex => encodeAbiParameters(swapToPayParams, [i]);

const vaultDepositParams = [{ type: "address", name: "vault" }, { type: "uint256", name: "assets" }] as const;

/** ERC-4626 deposit into an owner-allowlisted vault; shares are always minted to the account itself. */
export const encodeVaultDeposit = (i: { vault: Address; assets: bigint }): Hex =>
  encodeAbiParameters(vaultDepositParams, [i.vault, i.assets]);

export const decodeVaultDeposit = (data: Hex): { vault: Address; assets: bigint } => {
  const [vault, assets] = decodeAbiParameters(vaultDepositParams, data);
  return { vault, assets };
};

export const decodeSwapToPay = (data: Hex): SwapToPayInput => decodeAbiParameters(swapToPayParams, data)[0];

/** SaucerSwap V2 exact-output path: output token first, 3-byte fee between hops. */
export function exactOutputPath(tokens: readonly Address[], fees: readonly number[]): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) throw new Error("path needs n tokens and n-1 fees");
  let hex = tokens[0]!.slice(2);
  fees.forEach((fee, i) => {
    if (!Number.isInteger(fee) || fee < 0 || fee >= 2 ** 24) throw new Error(`invalid fee ${fee}`);
    hex += fee.toString(16).padStart(6, "0") + tokens[i + 1]!.slice(2);
  });
  return `0x${hex.toLowerCase()}`;
}

export const actionNameOf = (actionId: Hex): ActionName | undefined =>
  (Object.keys(ACTION_IDS) as ActionName[]).find(k => ACTION_IDS[k].toLowerCase() === actionId.toLowerCase());
