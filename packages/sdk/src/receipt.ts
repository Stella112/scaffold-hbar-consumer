import type { Address, Hex } from "viem";
import type { ActionName } from "./actions";
import type { ReasonCode } from "./errors";

export type ActorType = "owner" | "session" | "sponsor" | "guardian";

export type MirrorVerification =
  | { status: "verified"; result: string; consensusTimestamp: string; checkedAt: string }
  | { status: "mismatch"; result: string; detail: string; checkedAt: string }
  | { status: "pending"; detail: string; checkedAt: string };

export type HcsAuditReference = { topicId: string; sequenceNumber: number; consensusTimestamp: string };

type ReceiptBase = {
  id: string;
  account: Address;
  actor: Address;
  actorType: ActorType;
  sponsor: string | null;
  createdAt: string;
  hcsAudit: HcsAuditReference | null;
};

/** One receipt shape for every action. Success fields only exist on the success branch. */
export type Receipt =
  | (ReceiptBase & {
      status: "success";
      action: ActionName | "owner-intent" | "account-create";
      assetIn: Address | null;
      amountIn: bigint | null;
      assetOut: Address | null;
      amountOut: bigint | null;
      recipient: Address | null;
      transactionHash: Hex;
      transactionId: string | null;
      consensusTimestamp: string;
      networkFeeTinybars: bigint | null;
      mirror: MirrorVerification;
      protocolMetadata: Record<string, string>;
    })
  | (ReceiptBase & {
      status: "denied";
      action: ActionName | "owner-intent" | "account-create";
      reasonCode: ReasonCode | SponsorDenialCode;
      /** Where the denial happened: the sponsor's off-chain policy or the account contract. */
      deniedBy: "sponsor-policy" | "account-contract";
      transactionHash: Hex | null;
      detail: string;
    });

/** Off-chain sponsor policy denials (protect sponsor HBAR, not user funds). */
export type SponsorDenialCode =
  | "SPONSOR_BUDGET_EXCEEDED"
  | "SPONSOR_USER_BUDGET_EXCEEDED"
  | "SPONSOR_RATE_LIMITED"
  | "SPONSOR_DUPLICATE_REQUEST"
  | "SPONSOR_REQUEST_INVALID"
  | "SPONSOR_WRONG_NETWORK"
  | "SPONSOR_REQUEST_EXPIRED"
  | "SPONSOR_SIMULATION_FAILED";

/** JSON-safe serialisation (bigint → decimal string). */
export const receiptToJson = (r: Receipt): string =>
  JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
